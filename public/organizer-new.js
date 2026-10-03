// Create an event, step by step: venue → details → prices → poster → review.
//
// The event is saved as a draft once it has its prices (POST /events), so a poster can be
// attached to it (presigned upload, straight to object storage) and nothing is lost if the
// organizer stops halfway. Times are typed as the venue's clocks show them and converted in
// the browser (zonedTimeToUtc), so "7:30 PM" means 7:30 PM in Tokyo even when typed in Toronto.
import { CATEGORIES, count, longDate, money, time, utcToZonedInput, zonedTimeToUtc } from './format.js';
import { mountHeader } from './header.js';
import { api, describeError, restoreSession, withNext } from './session.js';

const $ = (id) => document.getElementById(id);
mountHeader({ active: 'organizer', onLogout: () => location.assign('/') });

const state = { step: 1, venue: null, sections: [], event: null, details: null, poster: 'none' };

// ─── navigation ─────────────────────────────────────────────────────────────────────────

function go(step) {
  state.step = step;
  for (let i = 1; i <= 5; i++) $(`step-${i}`).hidden = i !== step;
  for (const li of document.querySelectorAll('#steps li')) {
    const n = Number(li.dataset.step);
    if (n === step) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
    li.classList.toggle('done', n < step);
  }
  notice('');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

for (const back of document.querySelectorAll('[data-back]')) {
  back.addEventListener('click', () => go(Number(back.dataset.back)));
}

function notice(text) {
  $('notice').textContent = text;
}

function invalid(input, message) {
  input.setAttribute('aria-invalid', 'true');
  input.focus();
  notice(message);
  return false;
}

function clearInvalid(form) {
  for (const input of form.querySelectorAll('[aria-invalid]')) input.removeAttribute('aria-invalid');
}

// ─── 1. venue ───────────────────────────────────────────────────────────────────────────

let searchTimer;
$('venue-q').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void searchVenues($('venue-q').value.trim()), 250);
});

async function searchVenues(q) {
  const { data } = await api(`/venues?limit=${q ? 10 : 6}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  renderVenues(data);
}

function renderVenues(venues) {
  const list = $('venue-list');
  if (!venues.length) {
    list.replaceChildren(el('p', 'muted', 'No venues match. Add yours below.'));
    return;
  }
  list.replaceChildren(...venues.map(venueOption));
}

function venueOption(v) {
  const label = el('label', 'venue-option');
  const radio = el('input');
  radio.type = 'radio';
  radio.name = 'venue';
  radio.value = v.id;
  radio.checked = state.venue?.id === v.id;
  radio.addEventListener('change', () => (state.venue = v));
  const text = el('span');
  text.append(
    el('strong', '', v.name),
    el('span', 'muted', `${v.city} · ${count(v.capacity)} seats · ${v.timezone}`),
  );
  label.append(radio, text);
  return label;
}

// The new-venue form: sections from the stage back.
const sectionDefaults = [
  ['Stalls', 12, 20],
  ['Circle', 8, 18],
];

function addSectionRow([name, rows, seats] = ['', 5, 10]) {
  const row = el('div', 'section-row');
  row.append(
    field('Section', input('text', name, { maxLength: 50, className: 's-name' })),
    field('Rows', input('number', rows, { min: 1, max: 100, className: 's-rows' })),
    field('Seats per row', input('number', seats, { min: 1, max: 200, className: 's-seats' })),
  );
  const remove = el('button', 'secondary', 'Remove');
  remove.type = 'button';
  remove.setAttribute('aria-label', 'Remove this section');
  remove.addEventListener('click', () => {
    if ($('sections').children.length > 1) row.remove();
    updateCapacity();
  });
  row.append(remove);
  row.addEventListener('input', updateCapacity);
  $('sections').append(row);
  updateCapacity();
}

function sectionSpecs() {
  return [...$('sections').children].map((row) => ({
    name: row.querySelector('.s-name').value.trim(),
    rows: Number(row.querySelector('.s-rows').value),
    seatsPerRow: Number(row.querySelector('.s-seats').value),
  }));
}

function updateCapacity() {
  const total = sectionSpecs().reduce((n, s) => n + (s.rows * s.seatsPerRow || 0), 0);
  $('capacity').textContent = `Capacity: ${count(total)} seats`;
}

$('add-section').addEventListener('click', () => addSectionRow());

$('create-venue').addEventListener('click', async () => {
  const form = $('step-1');
  clearInvalid(form);
  const body = {
    name: $('v-name').value.trim(),
    address: $('v-address').value.trim(),
    city: $('v-city').value.trim(),
    country: $('v-country').value.trim().toUpperCase(),
    timezone: $('v-timezone').value.trim(),
    sections: sectionSpecs(),
  };
  if (!body.name) return invalid($('v-name'), 'Give the venue a name.');
  if (!body.address) return invalid($('v-address'), 'Add the venue’s address.');
  if (!body.city) return invalid($('v-city'), 'Add the city.');
  if (!/^[A-Z]{2}$/.test(body.country))
    return invalid($('v-country'), 'Use a two-letter country code, like US.');
  if (!body.timezone) return invalid($('v-timezone'), 'Choose the venue’s time zone.');
  if (body.sections.some((s) => !s.name)) return notice('Every section needs a name.');

  $('create-venue').disabled = true;
  try {
    const venue = await api('/venues', { method: 'POST', body });
    state.venue = venue;
    renderVenues([venue]);
    $('venue-q').value = '';
    $('new-venue').open = false;
    notice('');
  } catch (err) {
    notice(describeError(err));
  } finally {
    $('create-venue').disabled = false;
  }
});

$('step-1').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.venue) return notice('Choose a venue, or add a new one.');
  try {
    const venue = await api(`/venues/${state.venue.id}`);
    state.venue = venue;
    state.sections = venue.sections;
  } catch (err) {
    return notice(describeError(err));
  }
  const now = new Date();
  $('tz-note').textContent =
    `Times are local to ${state.venue.name}: ${state.venue.timezone} (it's ${time(now.toISOString(), state.venue.timezone)} there now).`;
  if (!$('e-starts').value) {
    // A sensible default: three weeks out, 7:30 PM at the venue, for three hours.
    const day = utcToZonedInput(
      new Date(Date.now() + 21 * 86_400_000).toISOString(),
      state.venue.timezone,
    ).slice(0, 10);
    $('e-starts').value = `${day}T19:30`;
    $('e-ends').value = `${day}T22:30`;
  }
  go(2);
});

// ─── 2. details ─────────────────────────────────────────────────────────────────────────

$('e-category').replaceChildren(...CATEGORIES.map((c) => new Option(c.single, c.id)));

$('step-2').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  clearInvalid(form);
  const tz = state.venue.timezone;
  const title = $('e-title').value.trim();
  if (!title) return invalid($('e-title'), 'Give the event a title.');
  if (!$('e-starts').value) return invalid($('e-starts'), 'When does it start?');
  if (!$('e-ends').value) return invalid($('e-ends'), 'When does it end?');
  const startsAt = zonedTimeToUtc($('e-starts').value, tz);
  const endsAt = zonedTimeToUtc($('e-ends').value, tz);
  const salesStartAt = $('e-sales').value ? zonedTimeToUtc($('e-sales').value, tz) : undefined;
  if (Date.parse(startsAt) <= Date.now()) return invalid($('e-starts'), 'The start has to be in the future.');
  if (endsAt <= startsAt) return invalid($('e-ends'), 'It has to end after it starts.');
  if (salesStartAt && salesStartAt >= startsAt)
    return invalid($('e-sales'), 'Sales have to open before the event starts.');
  const maxTicketsPerUser = Number($('e-max').value);
  if (!(maxTicketsPerUser >= 1 && maxTicketsPerUser <= 50))
    return invalid($('e-max'), 'Between 1 and 50 tickets.');

  state.details = {
    title,
    category: $('e-category').value,
    description: $('e-description').value.trim(),
    startsAt,
    endsAt,
    ...(salesStartAt ? { salesStartAt } : {}),
    maxTicketsPerUser,
  };
  renderPrices();
  go(3);
});

// ─── 3. prices, then the draft ──────────────────────────────────────────────────────────

function renderPrices() {
  if ($('prices').children.length === state.sections.length) return; // keep what was typed
  $('prices').replaceChildren(
    ...state.sections.map((s, i) =>
      field(
        `${s.name} · ${count(s.seats)} seats`,
        input('number', Math.max(20, 80 - i * 15).toFixed(2), {
          min: 0,
          step: '0.01',
          className: 'price',
          name: s.name,
        }),
      ),
    ),
  );
}

$('step-3').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearInvalid(e.currentTarget);
  const pricing = [];
  for (const priceInput of document.querySelectorAll('#prices .price')) {
    const value = Number(priceInput.value);
    if (priceInput.value === '' || !(value >= 0)) return invalid(priceInput, 'Every section needs a price.');
    pricing.push({ section: priceInput.name, priceCents: Math.round(value * 100) });
  }
  $('create-draft').disabled = true;
  try {
    const body = { venueId: state.venue.id, currency: $('e-currency').value, pricing, ...state.details };
    state.event = await api('/events', { method: 'POST', body });
    go(4);
  } catch (err) {
    if (err.code === 'VENUE_TIME_CONFLICT') {
      go(2);
      notice('The venue already has an event at that time. Choose another time.');
    } else notice(describeError(err));
  } finally {
    $('create-draft').disabled = false;
  }
});

// ─── 4. poster ──────────────────────────────────────────────────────────────────────────

/** A problem with the upload itself, worded for the organizer. */
class UploadError extends Error {}

$('skip-poster').addEventListener('click', () => showReview());

$('step-4').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = $('poster-file').files?.[0];
  if (!file) return showReview();
  if (!file.type.startsWith('image/')) return notice('Choose an image file.');
  const status = (text) => ($('poster-status').textContent = text);
  $('upload-poster').disabled = true;
  try {
    status('Uploading…');
    const upload = await api(`/events/${state.event.id}/poster/upload-url`, { method: 'POST' });
    if (file.size > upload.maxBytes) throw new UploadError('That image is larger than 10 MB.');
    // Straight to object storage: the file never passes through the API.
    const form = new FormData();
    for (const [name, value] of Object.entries(upload.fields)) form.append(name, value);
    form.append('Content-Type', file.type);
    form.append('file', file);
    const stored = await fetch(upload.url, { method: 'POST', body: form });
    if (!stored.ok) throw new UploadError(`The upload was refused (HTTP ${stored.status}).`);
    await api(`/events/${state.event.id}/poster`, { method: 'PUT', body: { key: upload.key } });

    status('Uploaded. Resizing…');
    for (let i = 0; i < 40; i++) {
      await new Promise((resolve) => setTimeout(resolve, 750));
      const event = await api(`/events/${state.event.id}`);
      if (event.poster?.status === 'ready') {
        $('poster-preview').src = event.poster.urls.medium;
        $('poster-preview').hidden = false;
        state.poster = 'ready';
        status('Poster ready.');
        break;
      }
      if (event.poster?.status === 'failed')
        throw new UploadError(event.poster.error ?? 'The image could not be processed.');
    }
    if (state.poster !== 'ready') status('Still resizing; it will appear on its own.');
    setTimeout(showReview, 600);
  } catch (err) {
    status('');
    notice(err instanceof UploadError ? err.message : describeError(err));
  } finally {
    $('upload-poster').disabled = false;
  }
});

// ─── 5. review and publish ──────────────────────────────────────────────────────────────

function showReview() {
  const ev = state.event;
  const tz = state.venue.timezone;
  const prices = [...document.querySelectorAll('#prices .price')]
    .map((p) => `${p.name} ${money(Math.round(Number(p.value) * 100), ev.currency)}`)
    .join(' · ');
  const rows = [
    ['Event', ev.title],
    ['When', `${longDate(ev.startsAt, tz)}, ${time(ev.startsAt, tz)} – ${time(ev.endsAt, tz)} (${tz})`],
    ['Where', `${state.venue.name}, ${state.venue.city}`],
    ['Seats', count(ev.seats.total)],
    ['Prices', prices],
    [
      'On sale',
      ev.salesStartAt
        ? `${longDate(ev.salesStartAt, tz)}, ${time(ev.salesStartAt, tz)}`
        : 'As soon as you publish',
    ],
    ['Per buyer', `Up to ${ev.maxTicketsPerUser} tickets`],
    ['Poster', state.poster === 'ready' ? 'Ready' : 'None'],
  ];
  $('review').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', '', k), el('dd', '', v)]));
  $('keep-draft').href = `/organizer/events/${ev.id}`;
  go(5);
}

$('publish').addEventListener('click', async () => {
  $('publish').disabled = true;
  try {
    await api(`/events/${state.event.id}`, { method: 'PATCH', body: { status: 'published' } });
    location.assign(`/organizer/events/${state.event.id}?published=1`);
  } catch (err) {
    notice(describeError(err));
    $('publish').disabled = false;
  }
});

// ─── helpers and start ──────────────────────────────────────────────────────────────────

function field(label, control) {
  const wrapper = el('label', 'field', label);
  wrapper.append(control);
  return wrapper;
}

function input(type, value, attrs = {}) {
  const node = el('input');
  node.type = type;
  node.value = String(value);
  Object.assign(node, attrs);
  return node;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function start() {
  const user = await restoreSession();
  if (!user) return location.replace(withNext('/login', '/organizer/events/new'));
  if (user.role === 'attendee') return location.replace('/organizer');
  $('v-timezone').value = Intl.DateTimeFormat().resolvedOptions().timeZone;
  $('timezones').replaceChildren(...(Intl.supportedValuesOf?.('timeZone') ?? []).map((z) => new Option(z)));
  for (const spec of sectionDefaults) addSectionRow(spec);
  go(1);
  await searchVenues('');
}

await start().catch((err) => notice(describeError(err)));
