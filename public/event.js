// The event page: details, the live seat map, and checkout. Plain browser JavaScript: no
// build step, no dependencies.
//
//   1. open a WebSocket to /api/v1/events/:id/live and wait for "hello"
//   2. load the seat-map snapshot, then apply live updates by seat version
//   3. select seats → hold them (with an Idempotency-Key) → countdown
//      (visitors log in first; booking needs a confirmed email, since tickets are emailed)
//   4. pay with a test card at the fake gateway → the webhook confirms the booking
//   5. show the QR tickets (they're emailed too, and listed under My tickets)

import {
  availabilityTag,
  categoryOf,
  dateBadge,
  eventHue,
  eventIcon,
  longDate,
  money,
  time,
} from './format.js';
import { mountHeader } from './header.js';
import {
  api,
  describeError,
  onSessionChange,
  reloadUser,
  restoreSession,
  session,
  withNext,
} from './session.js';

const $ = (id) => document.getElementById(id);
const PENDING_SELECTION = 'ticket-mng:pending-selection';
const SVG_NS = 'http://www.w3.org/2000/svg';
const CELL = 18; // grid pitch in px
const SEAT = 14; // seat size in px
const LABEL_WIDTH = 90;
const EVENT_ID = /^\/events\/([0-9a-f-]{36})\/?$/i.exec(location.pathname)?.[1] ?? null;

const state = {
  event: null,
  strandWarning: false,
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

// ─── account ───────────────────────────────────────────────────────────────────────────
// The header (menu, email-confirmation banner) is shared: header.js. The API client and
// token refresh: session.js.

mountHeader({
  active: 'events',
  onLogout: () => {
    clearBooking();
    showMessage('');
    log('logged out');
  },
});
onSessionChange(() => updateCheckout());

/** After logging in to book, bring back the seats the visitor had picked. */
function restorePendingSelection(eventId) {
  let pending;
  try {
    pending = JSON.parse(sessionStorage.getItem(PENDING_SELECTION) ?? 'null');
    sessionStorage.removeItem(PENDING_SELECTION);
  } catch {
    return;
  }
  if (!pending || pending.eventId !== eventId || state.booking || !session.user) return;
  const stillFree = pending.seatIds.filter((id) => state.seats.get(id)?.status === 'available');
  for (const id of stillFree) state.selected.add(id);
  repaintAll();
  updateCheckout();
  if (stillFree.length === pending.seatIds.length) {
    showMessage('Your seats are still selected. Hold them to continue.', true);
  } else if (stillFree.length) {
    showMessage('Some of your seats were taken meanwhile; the rest are still selected.');
  } else {
    showMessage('Sorry, the seats you picked were taken meanwhile. Pick others.');
  }
}

/** Back on an event with an unpaid hold (a reload, another tab)? Pick it up again. */
async function resumePendingHold() {
  if (!session.user || state.booking) return;
  const { data } = await api('/bookings?status=pending&limit=20');
  const hold = data.find((b) => b.event.id === EVENT_ID && Date.parse(b.expiresAt) > Date.now());
  if (!hold) return;
  state.selected.clear();
  showBooking(hold);
  updateCheckout();
  showMessage('You have seats on hold for this event. Pay before the timer runs out.', true);
}

// ─── the event ─────────────────────────────────────────────────────────────────────────

async function openEvent(eventId) {
  try {
    state.event = await api(`/events/${eventId}`);
  } catch (err) {
    showNotFound(err.status === 404 ? null : describeError(err));
    return false;
  }
  renderEventHeader(state.event);
  connectLive(eventId);
  return true;
}

function renderEventHeader(ev) {
  const category = categoryOf(ev.category);
  const hue = String(eventHue(ev.id, ev.category));
  document.title = `${ev.title} · Ticket MNG`;
  $('event-hero').style.setProperty('--hue', hue);

  const art = $('event-art');
  art.style.setProperty('--hue', hue);
  art.replaceChildren();
  if (ev.poster?.urls?.medium) {
    const img = document.createElement('img');
    img.className = 'card-poster';
    img.src = ev.poster.urls.medium;
    img.alt = '';
    art.append(img);
  } else {
    const icon = document.createElement('span');
    icon.className = 'card-icon';
    icon.textContent = eventIcon(ev.id, ev.category);
    art.append(icon);
  }
  const tz = ev.venue.timezone;
  const badge = dateBadge(ev.startsAt, tz);
  const date = document.createElement('div');
  date.className = 'date-badge';
  for (const [cls, text] of [
    ['month', badge.month],
    ['day', badge.day],
  ]) {
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = text;
    date.append(span);
  }
  art.append(date);

  $('event-category').textContent = category.single;
  const tag = availabilityTag(ev.seats);
  $('event-availability').hidden = !tag;
  if (tag) $('event-availability').textContent = tag.text;
  $('event-title').textContent = ev.title;
  $('event-date').textContent = longDate(ev.startsAt, tz);
  $('event-time').textContent = `· ${time(ev.startsAt, tz)} – ${time(ev.endsAt, tz)} (${ev.venue.city} time)`;
  $('event-venue').textContent = `${ev.venue.name}, ${ev.venue.city}`;
  $('event-price').textContent = ev.priceRange
    ? ev.priceRange.minCents === ev.priceRange.maxCents
      ? money(ev.priceRange.minCents, ev.currency)
      : `${money(ev.priceRange.minCents, ev.currency)} – ${money(ev.priceRange.maxCents, ev.currency)}`
    : 'Tickets not on sale';
  $('event-description').textContent = ev.description ?? '';

  const most = Math.min(8, ev.maxTicketsPerUser ?? 8);
  $('best-quantity').replaceChildren(
    ...Array.from(
      { length: most },
      (_, i) => new Option(`${i + 1} seat${i ? 's' : ''}`, String(i + 1), i === 1, i === 1),
    ),
  );
}

/** Price choices for "Best available": one per price on the map, cheapest first. */
function fillPriceChoices(map) {
  const prices = [...new Set(map.sections.flatMap((s) => s.seats.map((seat) => seat.priceCents)))].sort(
    (a, b) => a - b,
  );
  $('best-price').replaceChildren(
    new Option('Any price', ''),
    ...prices.slice(0, -1).map((p) => new Option(`Up to ${money(p, map.currency)}`, String(p))),
  );
}

function showNotFound(detail) {
  document.title = 'Event not found · Ticket MNG';
  $('event-title').textContent = detail ? "Couldn't load this event" : 'Event not found';
  $('event-description').textContent =
    detail ?? 'It may have been cancelled or moved. Browse all events to find something else.';
  $('event-category').hidden = true;
  document.querySelector('.event-facts').hidden = true;
  document.querySelector('main.layout').hidden = true;
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
  if (!state.seats.size) {
    renderMap(map);
    fillPriceChoices(map);
  } else mergeSnapshot(map);
  state.snapshotReady = true;
  applyUpdates(state.buffered.splice(0));
  restorePendingSelection(eventId);

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
  warnIfStranding();
}

/**
 * Picking seats by hand can leave one free seat squeezed between yours and a taken seat or
 * the end of the row. Nobody books a lone seat, so box offices discourage it; so do we (as a
 * hint, not a rule). "Best available" never does it.
 */
function warnIfStranding() {
  const rows = new Map();
  for (const entry of state.seats.values()) {
    const key = `${entry.section}|${entry.seat.y}`;
    if (!rows.has(key)) rows.set(key, new Map());
    rows.get(key).set(entry.seat.x, entry);
  }
  const taken = (e) => !e || e.status !== 'available' || state.selected.has(e.seat.id);
  const stranded = new Set();
  for (const id of state.selected) {
    const entry = state.seats.get(id);
    const row = rows.get(`${entry.section}|${entry.seat.y}`);
    for (const dx of [-1, 1]) {
      const neighbour = row.get(entry.seat.x + dx);
      if (neighbour && !taken(neighbour) && taken(row.get(entry.seat.x + 2 * dx))) stranded.add(neighbour);
    }
  }
  if (stranded.size) {
    const names = [...stranded].map((e) => `${e.section} ${e.seat.row}${e.seat.number}`).join(' and ');
    showMessage(
      `Heads up: this leaves ${names} on its own. Single seats rarely sell; could you shift over one?`,
    );
    state.strandWarning = true;
  } else if (state.strandWarning) {
    showMessage('');
    state.strandWarning = false;
  }
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
  const user = session.user;
  const hold = $('hold-button');
  const best = $('best-button');
  if (!user) {
    hold.disabled = !state.selected.size;
    hold.textContent = 'Log in to book';
    best.disabled = false;
    best.textContent = 'Log in to find seats';
  } else if (!user.emailVerified) {
    hold.disabled = best.disabled = true;
    hold.textContent = best.textContent = 'Confirm your email to book';
  } else {
    hold.disabled = !state.selected.size || Boolean(state.booking);
    hold.textContent = `Hold ${state.selected.size || ''} seat${state.selected.size === 1 ? '' : 's'}`;
    best.disabled = Boolean(state.booking);
    best.textContent = 'Find the best seats';
  }
}

// ─── hold → pay → tickets ──────────────────────────────────────────────────────────────

$('hold-button').addEventListener('click', async () => {
  if (!session.user) {
    // Keep the selection across the round trip through the login page.
    try {
      sessionStorage.setItem(
        PENDING_SELECTION,
        JSON.stringify({ eventId: state.event.id, seatIds: [...state.selected] }),
      );
    } catch {
      // storage unavailable (private mode): they'll pick again
    }
    location.assign(withNext('/login', `/events/${state.event.id}`));
    return;
  }
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
    showMessage(describeError(err));
    if (err.code === 'SEATS_UNAVAILABLE')
      for (const id of err.details?.seatIds ?? []) state.selected.delete(id);
    if (err.code === 'EMAIL_NOT_VERIFIED') await reloadUser().catch(() => {});
  } finally {
    repaintAll();
    updateCheckout();
  }
});

$('best-button').addEventListener('click', async () => {
  if (!session.user) {
    location.assign(withNext('/login', `/events/${state.event.id}`));
    return;
  }
  const quantity = Number($('best-quantity').value);
  const maxPriceCents = $('best-price').value ? Number($('best-price').value) : undefined;
  const idempotencyKey = crypto.randomUUID(); // reused by network retries, like holds
  $('best-button').disabled = true;
  try {
    const booking = await withNetworkRetry(() =>
      api(`/events/${state.event.id}/bookings/best`, {
        method: 'POST',
        body: { quantity, ...(maxPriceCents ? { maxPriceCents } : {}) },
        headers: { 'idempotency-key': idempotencyKey },
      }),
    );
    state.selected.clear();
    showBooking(booking);
    const where = `${booking.items[0].section}, row ${booking.items[0].row}`;
    const numbers = booking.items.map((i) => i.number).sort((a, b) => a - b);
    const seats = numbers.length > 1 ? `seats ${numbers[0]}–${numbers.at(-1)}` : `seat ${numbers[0]}`;
    log(`best available: held ${where}, ${seats}`);
    showMessage(
      `Got ${numbers.length} seat${numbers.length > 1 ? 's' : ''} together: ${where}, ${seats}. Pay before the timer runs out.`,
      true,
    );
  } catch (err) {
    showMessage(describeError(err));
    if (err.code === 'EMAIL_NOT_VERIFIED') await reloadUser().catch(() => {});
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
  $('tickets-link').hidden = true;
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
      showMessage(`Paid! Your tickets are below, and we've emailed them to ${session.user.email}.`, true);
      log('booking confirmed by webhook');
      await showTickets(bookingId);
      $('tickets-link').hidden = false;
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

if (!EVENT_ID) {
  showNotFound(null);
} else {
  await restoreSession();
  if (await openEvent(EVENT_ID)) await resumePendingHold().catch(() => {});
}
