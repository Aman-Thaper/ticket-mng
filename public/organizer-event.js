// An event's dashboard, for its organizer: the numbers (GET /events/:id/stats, every 10 s),
// ticket sales over time, the seat map with live updates (the same WebSocket buyers use),
// attendees with a CSV export, and publish / cancel.
import { drawBarChart } from './chart.js';
import { count, longDate, money, slug, time } from './format.js';
import { mountHeader } from './header.js';
import { drawSeatGrid } from './seat-grid.js';
import { api, describeError, restoreSession, withNext } from './session.js';

const $ = (id) => document.getElementById(id);
const EVENT_ID = /^\/organizer\/events\/([0-9a-f-]{36})\/?$/i.exec(location.pathname)?.[1] ?? null;
const STATS_EVERY_MS = 10_000;
const BUCKET_MS = { '5m': 300_000, '1h': 3_600_000, '1d': 86_400_000 };
const SVG_NS = 'http://www.w3.org/2000/svg';

const state = {
  event: null,
  bucket: '1h',
  seats: new Map(),
  snapshotReady: false,
  buffered: [],
  ws: null,
  attendeeCursor: null,
  attendeeQuery: '',
  attendeeRequest: 0,
};

mountHeader({ active: 'organizer', onLogout: () => location.assign('/') });

function notice(text) {
  $('notice').textContent = text;
}

function renderHead() {
  const ev = state.event;
  const tz = ev.venue.timezone;
  document.title = `${ev.title} · Dashboard · Ticket MNG`;
  $('title').textContent = ev.title;
  $('status').textContent = { draft: 'Draft', published: 'On sale', cancelled: 'Cancelled' }[ev.status];
  $('status').className = `status-pill ${ev.status === 'published' ? 'confirmed' : ev.status}`;
  $('when').textContent =
    `${longDate(ev.startsAt, tz)} · ${time(ev.startsAt, tz)} – ${time(ev.endsAt, tz)} · ${ev.venue.name}, ${ev.venue.city}`;
  $('view-page').href = `/events/${ev.id}`;
  $('open-scanner').href = `/scan?event=${ev.id}`;
  $('open-scanner').hidden = ev.status !== 'published';
  $('publish').hidden = ev.status !== 'draft';
  $('cancel-event').hidden = ev.status === 'cancelled';
}

// ─── numbers and the sales chart ────────────────────────────────────────────────────────

async function refreshStats() {
  try {
    const s = await api(`/events/${EVENT_ID}/stats?bucket=${state.bucket}`);
    const pct = s.seats.total ? Math.round((100 * s.seats.sold) / s.seats.total) : 0;
    $('stat-sold').textContent = count(s.seats.sold);
    $('stat-sold-sub').textContent = `of ${count(s.seats.total)} seats · ${pct}%`;
    $('sold-meter').style.width = `${pct}%`;
    $('stat-revenue').textContent = money(s.revenue.netCents, s.currency);
    $('stat-revenue-sub').textContent = s.revenue.refundedCents
      ? `after ${money(s.revenue.refundedCents, s.currency)} refunded`
      : `${count(s.bookings.confirmed)} booking${s.bookings.confirmed === 1 ? '' : 's'}`;
    $('stat-held').textContent = count(s.seats.held);
    $('stat-checked').textContent = count(s.checkedIn);
    $('stat-checked-sub').textContent = s.seats.sold
      ? `of ${count(s.seats.sold)} tickets · ${Math.round((100 * s.checkedIn) / s.seats.sold)}%`
      : 'no tickets sold yet';
    renderChart(s);
  } catch (err) {
    notice(describeError(err));
  }
}

function renderChart(s) {
  const tz = state.event.venue.timezone;
  const format = new Intl.DateTimeFormat(
    undefined,
    s.sales.bucket === '1d'
      ? { month: 'short', day: 'numeric', timeZone: tz }
      : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz },
  );
  drawBarChart(
    $('chart'),
    s.sales.points.map((p) => ({ ...p, value: p.tickets })),
    {
      bucketMs: BUCKET_MS[s.sales.bucket],
      label: (p) =>
        `${format.format(new Date(p.at))}: ${count(p.tickets)} ticket${p.tickets === 1 ? '' : 's'}, ${money(p.revenueCents, s.currency)}`,
      timeLabel: (d) => format.format(d),
      emptyText: {
        '5m': 'No sales in the last 24 hours',
        '1h': 'No sales in the last 14 days',
        '1d': 'No sales yet',
      }[s.sales.bucket],
    },
  );
}

for (const button of document.querySelectorAll('[data-bucket]')) {
  button.addEventListener('click', () => {
    state.bucket = button.dataset.bucket;
    for (const b of document.querySelectorAll('[data-bucket]'))
      b.setAttribute('aria-pressed', String(b === button));
    void refreshStats();
  });
}

// ─── the seat map, live ─────────────────────────────────────────────────────────────────

async function loadSeatSnapshot() {
  const map = await api(`/events/${EVENT_ID}/seats`);
  if (state.seats.size) {
    applySeats(map.sections.flatMap((s) => s.seats.map((seat) => [seat.id, seat.status, seat.version])));
  } else {
    drawSeatGrid($('seat-map'), map, (rect, seat, section) => {
      rect.setAttribute('class', `seat ${seat.status}`);
      const title = document.createElementNS(SVG_NS, 'title');
      title.textContent = `${section.name} ${seat.row}${seat.number}`;
      rect.append(title);
      state.seats.set(seat.id, { rect, version: seat.version });
    });
  }
  state.snapshotReady = true;
  applySeats(state.buffered.splice(0));
}

function applySeats(tuples) {
  for (const [id, status, version] of tuples) {
    const seat = state.seats.get(id);
    if (!seat || version <= seat.version) continue; // versions make updates order-proof
    seat.version = version;
    seat.rect.setAttribute('class', `seat ${status}`);
  }
}

/** Subscribe first, then load the snapshot: no change can fall in between (as on the event page). */
function connectLive() {
  const ws = new WebSocket(
    `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/events/${EVENT_ID}/live`,
  );
  state.ws = ws;
  state.snapshotReady = false;
  ws.onmessage = async (message) => {
    const data = JSON.parse(message.data);
    if (data.type === 'hello') await loadSeatSnapshot();
    else if (data.type === 'seats') {
      if (state.snapshotReady) applySeats(data.seats);
      else state.buffered.push(...data.seats);
    }
  };
  ws.onclose = () => {
    if (state.ws === ws && state.event.status === 'published')
      setTimeout(connectLive, 2_000 + Math.random() * 3_000);
  };
}

// ─── attendees ──────────────────────────────────────────────────────────────────────────

async function loadAttendees({ reset = false } = {}) {
  const request = ++state.attendeeRequest;
  const params = new URLSearchParams({ limit: '50' });
  if (state.attendeeQuery) params.set('q', state.attendeeQuery);
  if (!reset && state.attendeeCursor) params.set('cursor', state.attendeeCursor);
  const page = await api(`/events/${EVENT_ID}/attendees?${params}`);
  if (request !== state.attendeeRequest) return; // a newer search has started
  if (reset) $('attendee-rows').replaceChildren();
  const tz = state.event.venue.timezone;
  const stamp = (iso) =>
    iso ? `${new Date(iso).toLocaleDateString(undefined, { timeZone: tz })} ${time(iso, tz)}` : '—';
  for (const a of page.data) {
    const row = document.createElement('tr');
    for (const text of [
      a.name,
      a.email,
      `${a.seat.section} ${a.seat.row}${a.seat.number}`,
      stamp(a.purchasedAt),
      stamp(a.checkedInAt),
    ]) {
      const cell = document.createElement('td');
      cell.textContent = text;
      row.append(cell);
    }
    $('attendee-rows').append(row);
  }
  state.attendeeCursor = page.page.nextCursor;
  $('more-attendees').hidden = !state.attendeeCursor;
  $('attendee-empty').hidden = $('attendee-rows').children.length > 0;
  $('attendee-empty').textContent = state.attendeeQuery ? 'Nobody matches that search.' : 'No attendees yet.';
}

let searchTimer;
$('attendee-q').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.attendeeQuery = $('attendee-q').value.trim();
    loadAttendees({ reset: true }).catch((err) => notice(describeError(err)));
  }, 300);
});
$('more-attendees').addEventListener('click', () =>
  loadAttendees().catch((err) => notice(describeError(err))),
);

$('download-csv').addEventListener('click', async () => {
  $('download-csv').disabled = true;
  try {
    const q = state.attendeeQuery ? `?q=${encodeURIComponent(state.attendeeQuery)}` : '';
    const file = await api(`/events/${EVENT_ID}/attendees.csv${q}`, { responseType: 'blob' });
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slug(state.event.title)}-attendees.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (err) {
    notice(describeError(err));
  } finally {
    $('download-csv').disabled = false;
  }
});

// ─── publish and cancel ─────────────────────────────────────────────────────────────────

async function setStatus(status) {
  state.event = await api(`/events/${EVENT_ID}`, { method: 'PATCH', body: { status } });
  renderHead();
  await refreshStats();
}

$('publish').addEventListener('click', async () => {
  $('publish').disabled = true;
  try {
    await setStatus('published');
    notice('');
    connectLive();
  } catch (err) {
    notice(describeError(err));
  } finally {
    $('publish').disabled = false;
  }
});

$('cancel-event').addEventListener('click', () => ($('cancel-confirm').hidden = false));
$('keep-event').addEventListener('click', () => ($('cancel-confirm').hidden = true));
$('confirm-cancel').addEventListener('click', async () => {
  $('confirm-cancel').disabled = true;
  try {
    await setStatus('cancelled');
    $('cancel-confirm').hidden = true;
    state.ws?.close();
    notice('Cancelled. Refunds are on their way to every buyer.');
  } catch (err) {
    notice(describeError(err));
  } finally {
    $('confirm-cancel').disabled = false;
  }
});

// ─── start ──────────────────────────────────────────────────────────────────────────────

async function load() {
  const user = await restoreSession();
  if (!user) return location.replace(withNext('/login', location.pathname));
  if (user.role === 'attendee' || !EVENT_ID) return location.replace('/organizer');
  state.event = await api(`/events/${EVENT_ID}`);
  renderHead();
  if (new URLSearchParams(location.search).has('published')) notice('Published: it’s in the catalog now.');
  if (state.event.status === 'published') connectLive();
  else await loadSeatSnapshot(); // drafts and cancelled events don't stream
  await Promise.all([refreshStats(), loadAttendees({ reset: true })]);
  setInterval(() => {
    if (document.visibilityState === 'visible') void refreshStats();
  }, STATS_EVERY_MS);
}

await load().catch((err) => notice(describeError(err)));
