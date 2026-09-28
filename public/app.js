// Live seat map demo. Plain browser JavaScript: no build step, no dependencies.
//
// The flow it demonstrates:
//   1. open a WebSocket to /api/v1/events/:id/live and wait for "hello"
//   2. load the seat-map snapshot, then apply live updates by seat version
//   3. select seats → hold them (with an Idempotency-Key) → countdown
//   4. pay with a test card at the fake gateway → the webhook confirms the booking
//   5. show the QR tickets

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const CELL = 18; // grid pitch in px
const SEAT = 14; // seat size in px
const LABEL_WIDTH = 90;

const state = {
  token: null,
  user: null,
  event: null,
  /** seat id → { seat, section, label, status, version, el } */
  seats: new Map(),
  selected: new Set(),
  booking: null,
  countdown: null,
  ws: null,
  wsAttempt: 0,
  reconnectTimer: null,
  snapshotReady: false,
  buffered: [],
};

// ─── small helpers ─────────────────────────────────────────────────────────────────────

const money = (cents, currency) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);

function log(message) {
  const item = document.createElement('li');
  item.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
  $('log').prepend(item);
  while ($('log').children.length > 100) $('log').lastChild.remove();
}

function showMessage(text, ok = false) {
  $('message').textContent = text ?? '';
  $('message').classList.toggle('ok', ok);
}

function setLive(text, kind) {
  $('live-status').textContent = text;
  $('live-status').className = `pill ${kind}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── API client, with transparent access-token refresh ─────────────────────────────────

class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? `HTTP ${status}`);
    this.status = status;
    this.code = body?.error?.code;
    this.details = body?.error?.details;
  }
}

async function api(path, { method = 'GET', body, headers = {}, retryAuth = true } = {}) {
  const res = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // Access tokens live 15 minutes; on 401, trade the httpOnly refresh cookie for a new one.
  if (res.status === 401 && retryAuth && state.token && (await refreshSession())) {
    return api(path, { method, body, headers, retryAuth: false });
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

/** Retry a request after a network error. Safe for holds because the Idempotency-Key is reused. */
async function withNetworkRetry(request, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      return await request();
    } catch (err) {
      if (!(err instanceof TypeError) || i >= attempts) throw err; // TypeError = network failure
      log(`network error; retrying (${i}/${attempts - 1}) with the same Idempotency-Key`);
      await sleep(300 * i);
    }
  }
}

// ─── session ───────────────────────────────────────────────────────────────────────────

function setSession(auth) {
  state.token = auth?.accessToken ?? null;
  state.user = auth?.user ?? null;
  $('login-form').hidden = Boolean(state.user);
  $('session').hidden = !state.user;
  $('session-name').textContent = state.user ? `${state.user.name} · ${state.user.email}` : '';
  updateCheckout();
}

async function refreshSession() {
  const res = await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'same-origin' });
  if (!res.ok) {
    setSession(null);
    return false;
  }
  setSession(await res.json());
  return true;
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const auth = await api('/auth/login', {
      method: 'POST',
      body: { email: $('login-email').value, password: $('login-password').value },
      retryAuth: false,
    });
    setSession(auth);
    showMessage('');
    log(`logged in as ${auth.user.email}`);
  } catch (err) {
    showMessage(err.message);
  }
});

$('logout').addEventListener('click', async () => {
  await fetch('/api/v1/auth/logout', { method: 'POST', credentials: 'same-origin' });
  setSession(null);
  clearBooking();
  log('logged out');
});

// ─── events ────────────────────────────────────────────────────────────────────────────

async function loadEvents() {
  const { data } = await api('/events?limit=50');
  const select = $('event-select');
  select.replaceChildren();
  for (const ev of data) {
    const option = document.createElement('option');
    option.value = ev.id;
    option.textContent = `${new Date(ev.startsAt).toLocaleDateString()} · ${ev.title} · ${ev.venue.city}`;
    select.append(option);
  }
  const wanted = new URLSearchParams(location.search).get('event');
  if (wanted && ![...select.options].some((o) => o.value === wanted)) {
    const option = document.createElement('option');
    option.value = wanted;
    option.textContent = wanted;
    select.prepend(option);
  }
  select.value = wanted ?? data[0]?.id ?? '';
  if (select.value) await openEvent(select.value);
  else $('event-title').textContent = 'No upcoming events';
}

$('event-select').addEventListener('change', (e) => {
  const url = new URL(location.href);
  url.searchParams.set('event', e.target.value);
  history.replaceState(null, '', url);
  void openEvent(e.target.value);
});

async function openEvent(eventId) {
  clearBooking();
  state.selected.clear();
  state.seats.clear();
  $('seat-map').replaceChildren();
  try {
    state.event = await api(`/events/${eventId}`);
  } catch (err) {
    $('event-title').textContent = 'Event not found';
    showMessage(err.message);
    return;
  }
  $('event-title').textContent = state.event.title;
  const option = [...$('event-select').options].find((o) => o.value === eventId);
  if (option)
    option.textContent = `${new Date(state.event.startsAt).toLocaleDateString()} · ${state.event.title} · ${state.event.venue.city}`;
  $('event-meta').textContent =
    `${new Date(state.event.startsAt).toLocaleString()} · ${state.event.venue.name}, ${state.event.venue.city}` +
    (state.event.priceRange
      ? ` · ${money(state.event.priceRange.minCents, state.event.currency)}–${money(state.event.priceRange.maxCents, state.event.currency)}`
      : '');
  connectLive(eventId);
}

// ─── live updates ──────────────────────────────────────────────────────────────────────

function connectLive(eventId) {
  if (state.ws) {
    state.ws.onclose = null;
    state.ws.close();
  }
  clearTimeout(state.reconnectTimer);
  state.snapshotReady = false;
  state.buffered = [];
  setLive('connecting…', '');

  const ws = new WebSocket(
    `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/events/${eventId}/live`,
  );
  state.ws = ws;

  ws.onmessage = async (message) => {
    const data = JSON.parse(message.data);
    if (data.type === 'hello') {
      state.wsAttempt = 0;
      setLive('● live', 'live');
      log('live updates connected');
      // Subscribed first, snapshot second: nothing can fall in between.
      await loadSnapshot(eventId, Date.now());
    } else if (data.type === 'seats') {
      if (state.snapshotReady) applyUpdates(data.seats);
      else state.buffered.push(...data.seats);
    }
  };

  ws.onclose = (e) => {
    if (state.ws !== ws) return;
    state.snapshotReady = false;
    setLive('reconnecting…', 'down');
    // Exponential backoff with jitter: a whole audience reconnecting at once (say, after a
    // deploy) shouldn't hit the servers in one synchronized wave.
    const delay = Math.min(15_000, 1_000 * 2 ** state.wsAttempt++) * (0.5 + Math.random() / 2);
    log(`live connection closed (${e.code}); reconnecting in ${(delay / 1000).toFixed(1)} s`);
    state.reconnectTimer = setTimeout(() => connectLive(eventId), delay);
  };
}

async function loadSnapshot(eventId, subscribedAt) {
  const map = await api(`/events/${eventId}/seats`);
  if (state.event?.id !== eventId) return;
  if (!state.seats.size) renderMap(map);
  else mergeSnapshot(map);
  state.snapshotReady = true;
  applyUpdates(state.buffered.splice(0));

  // The snapshot comes from a ~1 s cache. If it predates our subscription, a change made in
  // that gap would be in neither, so fetch once more after the cache has turned over.
  if (Date.parse(map.generatedAt) < subscribedAt) {
    setTimeout(() => {
      if (state.event?.id === eventId) loadSnapshot(eventId, 0).catch(() => {});
    }, 1_200);
  }
}

function applyUpdates(tuples) {
  let changed = 0;
  for (const [id, status, version] of tuples) {
    const entry = state.seats.get(id);
    // Versions make updates idempotent and order-proof: anything not newer is stale.
    if (!entry || version <= entry.version) continue;
    entry.status = status;
    entry.version = version;
    if (status !== 'available' && state.selected.has(id)) {
      state.selected.delete(id);
      showMessage(`${entry.label} was just taken by someone else.`);
    }
    paint(id, true);
    changed++;
  }
  if (changed) {
    updateCounts();
    updateCheckout();
  }
}

function mergeSnapshot(map) {
  const tuples = map.sections.flatMap((s) => s.seats.map((seat) => [seat.id, seat.status, seat.version]));
  applyUpdates(tuples);
}

// ─── rendering ─────────────────────────────────────────────────────────────────────────

function renderMap(map) {
  const svg = $('seat-map');
  svg.replaceChildren();
  state.seats.clear();
  let maxX = 0;
  let maxY = 0;

  for (const section of map.sections) {
    const top = Math.min(...section.seats.map((s) => s.y));
    const title = document.createElementNS(SVG_NS, 'text');
    title.setAttribute('x', '0');
    title.setAttribute('y', String(top * CELL + SEAT - 2));
    title.setAttribute('class', 'section-label');
    title.textContent = section.name;
    svg.append(title);

    for (const seat of section.seats) {
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', String(LABEL_WIDTH + seat.x * CELL));
      rect.setAttribute('y', String(seat.y * CELL));
      rect.setAttribute('width', String(SEAT));
      rect.setAttribute('height', String(SEAT));
      rect.setAttribute('rx', '3');
      rect.setAttribute('tabindex', '0');
      rect.setAttribute('role', 'button');
      const label = `${section.name}, row ${seat.row}, seat ${seat.number}, ${money(seat.priceCents, map.currency)}`;
      rect.setAttribute('aria-label', label);
      rect.dataset.id = String(seat.id);
      svg.append(rect);
      state.seats.set(seat.id, {
        seat,
        section: section.name,
        label,
        status: seat.status,
        version: seat.version,
        el: rect,
      });
      paint(seat.id);
      maxX = Math.max(maxX, seat.x);
      maxY = Math.max(maxY, seat.y);
    }
  }

  const width = LABEL_WIDTH + (maxX + 1) * CELL;
  const height = (maxY + 1) * CELL;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  if (!map.sections.length)
    showMessage('This event has no seat inventory (the seed only stocks the next 1,000 shows).');
  updateCounts();
}

const heldByMe = () =>
  new Set(
    state.booking && state.booking.status === 'pending' ? state.booking.items.map((i) => i.seatId) : [],
  );

function paint(id, flash = false) {
  const entry = state.seats.get(id);
  if (!entry) return;
  const mine = heldByMe().has(id);
  const cls = state.selected.has(id) || mine ? 'selected' : entry.status;
  entry.el.setAttribute('class', `seat ${cls}${flash ? ' flash' : ''}`);
  // Drop the class when the animation ends, so the next change to this seat flashes again.
  if (flash)
    entry.el.addEventListener('animationend', () => entry.el.classList.remove('flash'), { once: true });
}

function repaintAll() {
  for (const id of state.seats.keys()) paint(id);
}

function updateCounts() {
  let available = 0;
  for (const entry of state.seats.values()) if (entry.status === 'available') available++;
  $('counts').textContent = state.seats.size ? `${available} of ${state.seats.size} available` : '';
}

// ─── selecting seats ───────────────────────────────────────────────────────────────────

function toggleSeat(id) {
  const entry = state.seats.get(id);
  if (!entry || state.booking) return;
  if (state.selected.has(id)) state.selected.delete(id);
  else if (entry.status === 'available') {
    if (state.selected.size >= (state.event?.maxTicketsPerUser ?? 10)) {
      showMessage(`At most ${state.event.maxTicketsPerUser} tickets per customer.`);
      return;
    }
    state.selected.add(id);
  }
  paint(id);
  updateCheckout();
}

$('seat-map').addEventListener('click', (e) => {
  const id = Number(e.target?.dataset?.id);
  if (id) toggleSeat(id);
});
$('seat-map').addEventListener('keydown', (e) => {
  const id = Number(e.target?.dataset?.id);
  if (id && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    toggleSeat(id);
  }
});
$('seat-map').addEventListener('mouseover', (e) => {
  const entry = state.seats.get(Number(e.target?.dataset?.id));
  $('map-tooltip').textContent = entry ? `${entry.label} · ${entry.status}` : ' ';
});

function updateCheckout() {
  const list = $('selection');
  list.replaceChildren();
  let total = 0;
  for (const id of state.selected) {
    const entry = state.seats.get(id);
    if (!entry) continue;
    total += entry.seat.priceCents;
    const item = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = `${entry.section} ${entry.seat.row}${entry.seat.number}`;
    const price = document.createElement('span');
    price.textContent = money(entry.seat.priceCents, state.event.currency);
    item.append(name, price);
    list.append(item);
  }
  $('selection-total').textContent = state.selected.size ? `Total ${money(total, state.event.currency)}` : '';
  $('hold-button').disabled = !state.user || !state.selected.size || Boolean(state.booking);
  $('hold-button').textContent = state.user
    ? `Hold ${state.selected.size || ''} seat${state.selected.size === 1 ? '' : 's'}`
    : 'Log in to book';
}

// ─── hold → pay → tickets ──────────────────────────────────────────────────────────────

$('hold-button').addEventListener('click', async () => {
  const seatIds = [...state.selected];
  // One key per logical attempt. Retries after a network error resend the SAME key, so the
  // server returns the original booking instead of trying to hold the seats twice.
  const idempotencyKey = crypto.randomUUID();
  $('hold-button').disabled = true;
  try {
    const booking = await withNetworkRetry(() =>
      api(`/events/${state.event.id}/bookings`, {
        method: 'POST',
        body: { seatIds },
        headers: { 'idempotency-key': idempotencyKey },
      }),
    );
    state.selected.clear();
    showBooking(booking);
    log(`held ${seatIds.length} seat(s): booking ${booking.id.slice(0, 8)}…`);
    showMessage('Seats held. Pay before the timer runs out.', true);
  } catch (err) {
    showMessage(err.message);
    if (err.code === 'SEATS_UNAVAILABLE')
      for (const id of err.details?.seatIds ?? []) state.selected.delete(id);
  } finally {
    repaintAll();
    updateCheckout();
  }
});

function showBooking(booking) {
  state.booking = booking;
  $('booking').hidden = false;
  $('booking-status').textContent = booking.status;
  const pending = booking.status === 'pending';
  $('pay-button').disabled = !pending;
  $('cancel-button').disabled = !pending;
  // Payment controls only make sense while the hold is open.
  $('card').closest('label').hidden = !pending;
  $('pay-button').closest('.row').hidden = !pending;
  clearInterval(state.countdown);
  const tick = () => {
    const left = Math.max(0, Date.parse(booking.expiresAt) - Date.now());
    if (!pending) {
      $('countdown').textContent = '';
      return;
    }
    const m = Math.floor(left / 60_000);
    const s = Math.floor((left % 60_000) / 1000);
    $('countdown').textContent = left ? `${m}:${String(s).padStart(2, '0')} left to pay` : 'Hold expired';
    if (!left) $('pay-button').disabled = true;
  };
  tick();
  state.countdown = setInterval(tick, 1000);
  repaintAll();
}

function clearBooking() {
  clearInterval(state.countdown);
  state.booking = null;
  $('booking').hidden = true;
  $('tickets').replaceChildren();
  repaintAll();
  updateCheckout();
}

$('pay-button').addEventListener('click', async () => {
  const booking = state.booking;
  $('pay-button').disabled = true;
  showMessage('');
  try {
    const payment = await api(`/bookings/${booking.id}/payment`, { method: 'POST' });
    log(`payment ${payment.id.slice(0, 8)}… created at ${payment.provider}`);
    if (payment.provider !== 'fake') {
      throw new Error(
        'This page pays through the built-in fake gateway. With Stripe, confirm the client secret with Stripe.js.',
      );
    }
    // What Stripe.js would do in a real checkout.
    const res = await fetch(`/fake-gateway/v1/payment_intents/${payment.providerPaymentId}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientSecret: payment.clientSecret, cardNumber: $('card').value }),
    });
    const intent = await res.json();
    if (!res.ok) throw new Error(intent?.error?.message ?? 'Payment failed');
    log(
      `gateway says: ${intent.status}${intent.last_payment_error ? ` (${intent.last_payment_error.message})` : ''}`,
    );
    await waitForOutcome(booking.id);
  } catch (err) {
    showMessage(err.message);
    if (state.booking?.status === 'pending') $('pay-button').disabled = false;
  }
});

/** The booking is confirmed by the provider's webhook, handled in a background job: poll for it. */
async function waitForOutcome(bookingId) {
  for (let i = 0; i < 40; i++) {
    const booking = await api(`/bookings/${bookingId}`);
    showBooking(booking);
    if (booking.status === 'confirmed') {
      showMessage('Paid! Your tickets are below, and on their way by email.', true);
      log('booking confirmed by webhook');
      await showTickets(bookingId);
      return;
    }
    if (booking.payment?.lastError) {
      showMessage(`${booking.payment.lastError} Try another card.`);
      $('pay-button').disabled = false;
      return;
    }
    if (booking.status !== 'pending') {
      showMessage(`Booking ${booking.status}${booking.refund ? `; refund ${booking.refund.status}` : ''}.`);
      return;
    }
    await sleep(500);
  }
  showMessage('Still waiting for the payment provider. Is the worker running (npm run worker)?');
}

async function showTickets(bookingId) {
  const tickets = await api(`/bookings/${bookingId}/tickets`);
  const box = $('tickets');
  box.replaceChildren();
  for (const t of tickets) {
    const card = document.createElement('div');
    card.className = 'ticket';
    const img = document.createElement('img');
    img.src = t.qr;
    img.alt = `QR code for ${t.seat.section} ${t.seat.row}${t.seat.number}`;
    const caption = document.createElement('div');
    caption.textContent = `${t.seat.section} · row ${t.seat.row} · seat ${t.seat.number}`;
    card.append(img, caption);
    box.append(card);
  }
}

$('cancel-button').addEventListener('click', async () => {
  try {
    await api(`/bookings/${state.booking.id}/cancel`, { method: 'POST' });
    log('hold cancelled; seats released');
    showMessage('');
    clearBooking();
  } catch (err) {
    showMessage(err.message);
  }
});

// ─── start ─────────────────────────────────────────────────────────────────────────────

(async () => {
  // Resume a session only if one exists (the httpOnly refresh cookie is invisible to us;
  // the has_session hint cookie isn't). Avoids a pointless 401 for logged-out visitors.
  if (document.cookie.split('; ').includes('has_session=1')) await refreshSession().catch(() => {});
  updateCheckout();
  await loadEvents().catch((err) => showMessage(err.message));
})();
