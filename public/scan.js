// The door scanner: staff point a phone at a ticket's QR code and get a clear yes or no.
//
//   1. Check the signature on the device, with the published public key (WebCrypto
//      Ed25519; see src/modules/tickets/signing.ts). A forged or garbled code is rejected
//      at once, even with no signal.
//   2. Check the event: the ticket's own payload says which show it's for.
//   3. Ask the server (POST /check-in), which admits each ticket exactly once.
//   4. No signal? A genuine ticket is admitted provisionally and remembered on the device
//      (scan-store.js), so a second scan here is still caught. It's checked in, with its
//      real scan time, when the connection returns; anything the server then refuses (used
//      at another door, refunded) is listed for staff.
//
// Cameras need HTTPS (or localhost). Without one, a photo or a typed code works too.
import { count } from './format.js';
import { mountHeader } from './header.js';
import { getMeta, getScan, pruneScans, putScan, allScans, setMeta, unsyncedScans } from './scan-store.js';
import { api, describeError, restoreSession, session, withNext } from './session.js';

const $ = (id) => document.getElementById(id);

/** The camera sees the same code many times a second: one decision per code per window. */
const REPEAT_WINDOW_MS = 3_000;
const ATTENDANCE_POLL_MS = 3_000;
const SYNC_EVERY_MS = 15_000;
/** Include shows already under way in the event list. */
const STARTED_UP_TO_MS = 12 * 3_600_000;

const state = {
  events: [],
  event: null,
  /** CryptoKey for checking signatures, or null when unavailable (then the server checks). */
  key: null,
  detector: null,
  stream: null,
  lastCode: null,
  lastCodeAt: 0,
  busy: false,
  syncing: false,
  pollTimer: null,
  /** { sold, checkedIn, recent } as shown, or null before the first answer. */
  attendance: null,
  lastLocalCheckInAt: 0,
};

mountHeader({ onLogout: () => location.assign('/') });

// ─── tickets ────────────────────────────────────────────────────────────────────────────

const fromBase64Url = (s) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

function toUuid(bytes) {
  const h = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** <payload>.<signature>; payload = version 1 ‖ ticket id ‖ event id. Null if it isn't one. */
function parseTicket(code) {
  const token = code.trim();
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  try {
    const payload = fromBase64Url(parts[0]);
    const signature = fromBase64Url(parts[1]);
    if (payload.length !== 33 || payload[0] !== 1 || signature.length !== 64) return null;
    return {
      token,
      payload,
      signature,
      ticketId: toUuid(payload.subarray(1, 17)),
      eventId: toUuid(payload.subarray(17, 33)),
    };
  } catch {
    return null; // not base64url
  }
}

async function loadKey() {
  let jwk;
  try {
    ({ jwk } = await api('/tickets/public-key'));
    await setMeta('publicKey', jwk);
  } catch {
    jwk = await getMeta('publicKey'); // offline: the copy from last time
  }
  if (!jwk) return null;
  try {
    return await crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['verify']);
  } catch {
    return null; // no Ed25519 in this browser's WebCrypto: the server checks every ticket
  }
}

// ─── deciding ───────────────────────────────────────────────────────────────────────────

const clock = (iso) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
const seatText = (seat) => `${seat.section} · Row ${seat.row} · Seat ${seat.number}`;

async function check(code) {
  const now = Date.now();
  if (code === state.lastCode && now - state.lastCodeAt < REPEAT_WINDOW_MS) return;
  if (state.busy) return;
  state.lastCode = code;
  state.lastCodeAt = now;
  state.busy = true;
  try {
    show(await decide(code));
  } finally {
    state.busy = false;
  }
}

async function decide(code) {
  const ticket = parseTicket(code);
  if (!ticket) return bad('Not a Ticket MNG ticket', "This QR code isn't one of our tickets.");
  if (state.key && !(await crypto.subtle.verify('Ed25519', state.key, ticket.signature, ticket.payload))) {
    return bad('Fake ticket', "The signature doesn't match: Ticket MNG didn't issue this code.");
  }
  if (ticket.eventId !== state.event.id) {
    const other = state.events.find((e) => e.id === ticket.eventId);
    return bad('Wrong event', `This ticket is for ${other ? other.title : 'another event'}.`);
  }
  const earlier = await getScan(ticket.ticketId);
  if (earlier) {
    return bad(
      'Already scanned',
      `Admitted on this device at ${clock(earlier.scannedAt)}${earlier.label ? `: ${earlier.label}` : ''}.`,
    );
  }

  try {
    const admitted = await api('/check-in', { method: 'POST', body: { token: ticket.token } });
    await putScan({
      ticketId: ticket.ticketId,
      eventId: ticket.eventId,
      token: ticket.token,
      label: `${admitted.holder}, ${seatText(admitted.seat)}`,
      scannedAt: admitted.checkedInAt,
      synced: true,
    });
    countOwnCheckIn(admitted);
    return { tone: 'good', title: `Welcome, ${admitted.holder}`, detail: seatText(admitted.seat) };
  } catch (err) {
    if (err instanceof TypeError) return admitOffline(ticket); // no connection
    return refusal(err);
  }
}

function refusal(err) {
  switch (err.code) {
    case 'ALREADY_CHECKED_IN':
      return bad('Already used', `This ticket was scanned at ${clock(err.details?.checkedInAt)}.`);
    case 'TICKET_VOID':
      return bad('Refunded ticket', 'This ticket was refunded and is no longer valid.');
    case 'INVALID_TICKET':
      return bad('Fake ticket', "The signature doesn't match: Ticket MNG didn't issue this code.");
    case 'NOT_FOUND':
      return bad('Unknown ticket', 'No such ticket exists.');
    case 'FORBIDDEN':
      return bad('Not your event', 'You can only check in tickets for your own events.');
    default:
      return bad("Couldn't check this ticket", describeError(err));
  }
}

async function admitOffline(ticket) {
  if (!state.key) {
    return bad(
      "Can't check offline",
      "This device hasn't loaded the key for checking tickets yet. Connect once, then try again.",
    );
  }
  await putScan({
    ticketId: ticket.ticketId,
    eventId: ticket.eventId,
    token: ticket.token,
    label: '',
    scannedAt: new Date().toISOString(),
    synced: false,
  });
  void renderSyncStatus();
  return {
    tone: 'offline',
    title: 'Admitted (offline)',
    detail: 'A genuine ticket. It will be checked in when the connection returns.',
  };
}

const bad = (title, detail) => ({ tone: 'bad', title, detail });

function show({ tone, title, detail }) {
  const box = $('result');
  box.className = `result ${tone}`;
  $('result-icon').textContent = { good: '✓', offline: '✓', bad: '✕' }[tone] ?? '⌁';
  $('result-title').textContent = title;
  $('result-detail').textContent = detail;
  void box.offsetWidth; // restart the flash animation
  box.classList.add('flash');
  navigator.vibrate?.(tone === 'bad' ? [120, 80, 120] : 60);
}

// ─── reading QR codes ───────────────────────────────────────────────────────────────────

/** The browser's own BarcodeDetector where there is one (Chrome, Edge, Android); jsQR elsewhere. */
async function createDetector() {
  if (
    'BarcodeDetector' in window &&
    (await window.BarcodeDetector.getSupportedFormats()).includes('qr_code')
  ) {
    const native = new window.BarcodeDetector({ formats: ['qr_code'] });
    return { detect: async (source) => (await native.detect(source))[0]?.rawValue ?? null };
  }
  await loadScript('/vendor/jsQR.js');
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  return {
    detect: async (source) => {
      const width = source.videoWidth ?? source.width;
      const height = source.videoHeight ?? source.height;
      if (!width || !height) return null;
      // Decoding is pixel by pixel: shrink big photos first.
      const scale = Math.min(1, 1000 / Math.max(width, height));
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      return window.jsQR(data, canvas.width, canvas.height)?.data ?? null;
    },
  };
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.append(script);
  });
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    show(
      bad(
        'No camera here',
        'Browsers only allow the camera on HTTPS. Upload a photo or type the code instead.',
      ),
    );
    return;
  }
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
  } catch (err) {
    show(
      bad(
        'No camera',
        err.name === 'NotAllowedError'
          ? 'Camera access is blocked. Allow it in the browser settings, or upload a photo.'
          : 'No usable camera was found. Upload a photo or type the code instead.',
      ),
    );
    return;
  }
  const video = $('video');
  video.srcObject = state.stream;
  await video.play();
  state.detector ??= await createDetector();
  $('camera-button').textContent = 'Stop camera';
  document.querySelector('.camera').classList.add('on');
  void scanFrames();
}

function stopCamera() {
  for (const track of state.stream?.getTracks() ?? []) track.stop();
  state.stream = null;
  $('video').srcObject = null;
  $('camera-button').textContent = 'Start camera';
  document.querySelector('.camera').classList.remove('on');
}

async function scanFrames() {
  const video = $('video');
  while (state.stream) {
    if (video.readyState >= video.HAVE_CURRENT_DATA) {
      const code = await state.detector.detect(video).catch(() => null);
      if (code) await check(code);
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

// ─── syncing offline check-ins ──────────────────────────────────────────────────────────

function problemText(err) {
  if (err.code === 'ALREADY_CHECKED_IN')
    return `Already used at ${clock(err.details?.checkedInAt)}: admitted twice.`;
  if (err.code === 'TICKET_VOID') return 'Refunded ticket: it was admitted anyway.';
  return describeError(err);
}

async function syncQueue() {
  if (state.syncing) return;
  const pending = await unsyncedScans();
  if (!pending.length) return renderSyncStatus();
  state.syncing = true;
  try {
    if (!session.token && !(await restoreSession())) return; // still offline, or logged out
    for (const scan of pending) {
      try {
        const admitted = await api('/check-in', {
          method: 'POST',
          body: { token: scan.token, scannedAt: scan.scannedAt },
        });
        await putScan({ ...scan, synced: true, label: `${admitted.holder}, ${seatText(admitted.seat)}` });
      } catch (err) {
        if (err instanceof TypeError) break; // the connection dropped again: retry later
        await putScan({ ...scan, synced: true, problem: problemText(err) });
      }
    }
  } finally {
    state.syncing = false;
    await renderSyncStatus();
    await renderProblems();
    void refreshAttendance();
  }
}

async function renderSyncStatus() {
  const waiting = (await unsyncedScans()).length;
  const status = $('sync-status');
  status.hidden = !waiting;
  status.textContent = `${waiting} check-in${waiting === 1 ? '' : 's'} waiting to sync`;
}

async function renderProblems() {
  const problems = (await allScans()).filter((s) => s.problem && s.eventId === state.event?.id);
  $('problems').hidden = !problems.length;
  $('problem-list').replaceChildren(
    ...problems.map((p) =>
      el('li', '', `${clock(p.scannedAt)} · ${p.label || p.ticketId.slice(0, 8)}: ${p.problem}`),
    ),
  );
}

$('dismiss-problems').addEventListener('click', async () => {
  for (const { problem, ...scan } of await allScans()) if (problem) await putScan(scan);
  await renderProblems();
});

// ─── attendance ─────────────────────────────────────────────────────────────────────────

async function refreshAttendance() {
  const event = state.event;
  if (!event || !session.token) return;
  try {
    const a = await api(`/events/${event.id}/attendance`);
    if (state.event !== event) return;
    // The server caches attendance for a second, so an answer right after our own check-in
    // can predate it. Don't let the count step backwards because of that.
    const justScanned = Date.now() - state.lastLocalCheckInAt < 2_000;
    if (justScanned && state.attendance && a.checkedIn < state.attendance.checkedIn) return;
    renderAttendance(a);
  } catch {
    // offline: keep showing the last numbers
  }
}

/** Our own check-in shows at once; the next poll brings everyone else's. */
function countOwnCheckIn(admitted) {
  state.lastLocalCheckInAt = Date.now();
  if (!state.attendance) return void refreshAttendance();
  renderAttendance({
    ...state.attendance,
    checkedIn: state.attendance.checkedIn + 1,
    recent: [admitted, ...state.attendance.recent].slice(0, 10),
  });
}

function renderAttendance(a) {
  state.attendance = a;
  $('checked-in').textContent = count(a.checkedIn);
  $('sold').textContent = count(a.sold);
  $('bar-fill').style.width = `${a.sold ? Math.min(100, (100 * a.checkedIn) / a.sold) : 0}%`;
  $('recent').replaceChildren(
    ...a.recent.map((r) =>
      el('li', '', `${clock(r.checkedInAt)}  ${r.holder} · ${r.seat.section} ${r.seat.row}${r.seat.number}`),
    ),
  );
}

function pollAttendance() {
  clearTimeout(state.pollTimer);
  const tick = async () => {
    if (document.visibilityState === 'visible') await refreshAttendance();
    state.pollTimer = setTimeout(tick, ATTENDANCE_POLL_MS);
  };
  void tick();
}

// ─── setup ──────────────────────────────────────────────────────────────────────────────

async function loadEvents(user) {
  const query = new URLSearchParams({
    from: new Date(Date.now() - STARTED_UP_TO_MS).toISOString(),
    limit: '50',
  });
  if (user.role !== 'admin') query.set('organizerId', user.id);
  try {
    const { data } = await api(`/events?${query}`);
    const events = data.map((e) => ({ id: e.id, title: e.title, startsAt: e.startsAt, venue: e.venue.name }));
    await setMeta('events', events);
    return events;
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    return (await getMeta('events')) ?? [];
  }
}

function selectEvent(id) {
  state.event = state.events.find((e) => e.id === id) ?? state.events[0];
  $('event').value = state.event.id;
  const url = new URL(location.href);
  url.searchParams.set('event', state.event.id);
  history.replaceState(null, '', url);
  state.attendance = null;
  $('checked-in').textContent = '–';
  $('sold').textContent = '–';
  $('bar-fill').style.width = '0';
  $('recent').replaceChildren();
  state.lastCode = null;
  show({ tone: 'idle', title: 'Ready to scan', detail: "Point the camera at a ticket's QR code." });
  void refreshAttendance();
  void renderProblems();
}

function notice(text) {
  $('notice').textContent = text;
  $('notice').hidden = false;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function start() {
  const user = await restoreSession();
  if (!user && !session.offline) {
    location.replace(withNext('/login', location.pathname + location.search));
    return;
  }
  if (user?.role === 'attendee') {
    notice('The door scanner is for event organizers. Your own tickets are under My tickets.');
    return;
  }
  [state.key, state.events] = await Promise.all([
    loadKey(),
    user ? loadEvents(user) : getMeta('events').then((events) => events ?? []),
  ]);
  if (!state.events.length) {
    notice(
      user
        ? "You don't have any published events coming up."
        : "You're offline, and this device hasn't loaded your events yet. Connect once, then scan offline.",
    );
    return;
  }

  $('event').replaceChildren(
    ...state.events.map((e) => new Option(`${e.title} · ${new Date(e.startsAt).toLocaleDateString()}`, e.id)),
  );
  $('event').addEventListener('change', (e) => selectEvent(e.target.value));
  $('scanner').hidden = false;
  selectEvent(new URLSearchParams(location.search).get('event'));

  $('camera-button').addEventListener('click', () => (state.stream ? stopCamera() : void startCamera()));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && state.stream) stopCamera(); // save the battery
  });
  $('photo').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    state.detector ??= await createDetector();
    const image = await createImageBitmap(file);
    const code = await state.detector.detect(image).catch(() => null);
    image.close();
    if (!code) return show(bad('No QR code found', 'Try a sharper photo, closer to the code.'));
    state.lastCode = null; // a deliberate upload always gets an answer
    await check(code);
  });
  $('manual').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('code').value.trim();
    $('code').value = '';
    state.lastCode = null;
    if (code) void check(code);
  });

  await pruneScans();
  pollAttendance();
  void syncQueue();
  setInterval(() => void syncQueue(), SYNC_EVERY_MS);
  window.addEventListener('online', () => void syncQueue());
}

await start().catch((err) => notice(describeError(err)));
