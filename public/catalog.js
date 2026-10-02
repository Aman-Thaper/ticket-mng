// The catalog: events on sale, by category, with search. State lives in the URL
// (?category=…&q=…), so links can be shared and the back button works. The home page opens
// with "Trending now" (the events most people are viewing right now), and any card whose
// event is being watched says how many people are on it.
import {
  availabilityTag,
  CATEGORIES,
  categoryOf,
  compactCount,
  dateBadge,
  eventHue,
  eventIcon,
  priceText,
  when,
} from './format.js';
import { mountHeader } from './header.js';
import { api, describeError, restoreSession } from './session.js';

const $ = (id) => document.getElementById(id);
const results = $('results');

// Links from before the catalog existed pointed at /?event=<id>: send them to the event page.
const legacyEvent = new URLSearchParams(location.search).get('event');
if (legacyEvent) location.replace(`/events/${encodeURIComponent(legacyEvent)}`);

mountHeader({ active: 'events' });
void restoreSession();

// ─── state in the URL ───────────────────────────────────────────────────────────────────

function readState() {
  const params = new URLSearchParams(location.search);
  const category = params.get('category');
  return {
    category: CATEGORIES.some((c) => c.id === category) ? category : '',
    q: (params.get('q') ?? '').trim(),
  };
}

function navigate(next) {
  const state = { ...readState(), ...next };
  const params = new URLSearchParams();
  if (state.category) params.set('category', state.category);
  if (state.q) params.set('q', state.q);
  const url = params.size ? `/?${params}` : '/';
  if (url !== location.pathname + location.search) history.pushState(null, '', url);
  void render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

window.addEventListener('popstate', () => void render());

for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => navigate({ category: chip.dataset.category }));
}

$('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  navigate({ q: $('q').value.trim() });
});

// ─── rendering ──────────────────────────────────────────────────────────────────────────

let renderId = 0; // a newer render makes older, slower ones drop their results

/** Event id → people viewing it now, for the badges on cards. Refreshed on every render. */
let viewersById = new Map();

/** The events most people are viewing right now. Optional extra: on failure, just none. */
async function loadTrending() {
  const trending = await api('/events/trending?limit=10').then(
    (res) => res.data,
    () => [],
  );
  viewersById = new Map(trending.map((e) => [e.id, e.live.viewers]));
  return trending;
}

async function render() {
  const { category, q } = readState();
  const id = ++renderId;
  $('q').value = q;
  for (const chip of document.querySelectorAll('.chip')) {
    chip.setAttribute('aria-pressed', String(chip.dataset.category === category));
  }
  document.title = q
    ? `“${q}” · Ticket MNG`
    : category
      ? `${categoryOf(category).label} · Ticket MNG`
      : 'Ticket MNG · Live events and tickets';

  try {
    if (!category && !q) await renderRows(id);
    else await renderGrid(id, { category, q });
  } catch (err) {
    if (id !== renderId) return;
    results.replaceChildren(
      emptyState(
        'Something went wrong',
        describeError(err),
        button('Try again', () => void render()),
      ),
    );
  }
}

/** Home: "Trending now" (when anyone is watching anything), then one row per category. */
async function renderRows(id) {
  results.replaceChildren(...CATEGORIES.slice(0, 3).map((c) => rowSkeleton(c)));
  const [trending, lists] = await Promise.all([
    loadTrending(),
    Promise.all(
      CATEGORIES.map((c) =>
        api(`/events?onSale=true&category=${c.id}&limit=12`).then(
          (page) => page.data,
          () => [],
        ),
      ),
    ),
  ]);
  if (id !== renderId) return;
  const rows = CATEGORIES.map((c, i) =>
    lists[i].length
      ? row({ title: `${c.icon} ${c.label}`, noun: c.label.toLowerCase(), category: c.id }, lists[i])
      : null,
  ).filter(Boolean);
  if (rows.length && trending.length) {
    rows.unshift(row({ title: '🔥 Trending now', noun: 'trending events', trending: true }, trending));
  }
  results.replaceChildren(
    ...(rows.length
      ? rows
      : [emptyState('No events on sale right now', 'New events are added every week. Check back soon.')]),
  );
}

function row({ title, noun, category, trending = false }, events) {
  const section = el('section', trending ? 'event-row trending' : 'event-row');
  const head = el('div', 'row-head');
  const heading = el('h2', '', title);
  if (trending) heading.append(el('span', 'row-subtitle', 'Most people viewing right now'));
  const actions = el('div', 'row-actions');
  const rail = el('div', 'rail');
  const scrollBy = (dir) => rail.scrollBy({ left: dir * rail.clientWidth * 0.9, behavior: 'smooth' });
  const prev = button('‹', () => scrollBy(-1), 'rail-button');
  const next = button('›', () => scrollBy(1), 'rail-button');
  prev.setAttribute('aria-label', `Earlier ${noun}`);
  next.setAttribute('aria-label', `More ${noun}`);
  if (category) actions.append(button('See all', () => navigate({ category }), 'see-all'));
  actions.append(prev, next);
  head.append(heading, actions);
  rail.append(...events.map(card));
  section.append(head, rail);
  return section;
}

/** A category and/or a search: a grid, with "Load more". */
async function renderGrid(id, { category, q }) {
  const heading = el('div', 'grid-head');
  const title = q
    ? `Results for “${q}”${category ? ` in ${categoryOf(category).label}` : ''}`
    : `${categoryOf(category).icon} ${categoryOf(category).label}`;
  heading.append(el('h2', '', title), el('p', 'muted', 'Upcoming events on sale, soonest first'));
  const grid = el('div', 'grid');
  grid.append(...Array.from({ length: 8 }, cardSkeleton));
  results.replaceChildren(heading, grid);

  const query = new URLSearchParams({ onSale: 'true', limit: '24' });
  if (category) query.set('category', category);
  if (q) query.set('q', q);

  const trending = loadTrending(); // for the viewer badges; fetched alongside the first page
  const loadPage = async (cursor) => {
    if (cursor) query.set('cursor', cursor);
    const [page] = await Promise.all([api(`/events?${query}`), trending]);
    if (id !== renderId) return;
    grid.querySelectorAll('.skeleton').forEach((s) => s.remove());
    grid.append(...page.data.map(card));
    results.querySelector('.load-more')?.remove();
    if (!grid.children.length) {
      results.replaceChildren(
        heading,
        emptyState(
          q ? `No events match “${q}”` : 'Nothing on sale here yet',
          q ? 'Try another search, or browse all events.' : 'New events are added every week.',
          button('Browse all events', () => navigate({ category: '', q: '' })),
        ),
      );
      return;
    }
    if (page.page.nextCursor) {
      const more = button('Load more events', async () => {
        more.disabled = true;
        more.textContent = 'Loading…';
        await loadPage(page.page.nextCursor).catch(() => {
          more.disabled = false;
          more.textContent = 'Load more events';
        });
      });
      more.classList.add('load-more');
      results.append(more);
    }
  };
  await loadPage();
}

// ─── pieces ─────────────────────────────────────────────────────────────────────────────

function card(event) {
  const category = categoryOf(event.category);
  const link = el('a', 'card');
  link.href = `/events/${event.id}`;

  const art = el('div', 'card-art');
  art.style.setProperty('--hue', String(eventHue(event.id, event.category)));
  const poster = event.poster?.urls?.medium;
  if (poster) {
    const img = el('img', 'card-poster');
    img.src = poster;
    img.alt = '';
    img.loading = 'lazy';
    art.append(img);
  } else {
    const icon = el('span', 'card-icon', eventIcon(event.id, event.category));
    icon.setAttribute('aria-hidden', 'true');
    art.append(icon);
  }
  const badge = dateBadge(event.startsAt, event.venue.timezone);
  const date = el('div', 'date-badge');
  date.append(el('span', 'month', badge.month), el('span', 'day', badge.day));
  art.append(date, el('span', 'category-tag', category.single));
  const tag = availabilityTag(event.seats);
  if (tag) art.append(el('span', `status-tag ${tag.tone}`, tag.text));
  const viewers = viewersById.get(event.id);
  if (viewers) {
    const live = el('span', 'viewers-tag');
    const dot = el('i', 'pulse');
    dot.setAttribute('aria-hidden', 'true');
    live.append(dot, `${compactCount(viewers)} viewing`);
    art.append(live);
  }

  const body = el('div', 'card-body');
  body.append(
    el('h3', 'card-title', event.title),
    el('p', 'card-meta', when(event.startsAt, event.venue.timezone)),
    el('p', 'card-meta', `${event.venue.name} · ${event.venue.city}`),
    el(
      'p',
      'card-price',
      event.seats?.available === 0 ? 'Sold out' : priceText(event.priceRange, event.currency),
    ),
  );
  link.append(art, body);
  return link;
}

function cardSkeleton() {
  const s = el('div', 'card skeleton');
  s.append(el('div', 'card-art'), el('div', 'card-body'));
  s.setAttribute('aria-hidden', 'true');
  return s;
}

function rowSkeleton(category) {
  const section = el('section', 'event-row');
  const head = el('div', 'row-head');
  head.append(el('h2', '', `${category.icon} ${category.label}`));
  const rail = el('div', 'rail');
  rail.append(...Array.from({ length: 5 }, cardSkeleton));
  section.append(head, rail);
  return section;
}

function emptyState(title, text, action) {
  const box = el('div', 'empty');
  box.append(el('h2', '', title), el('p', 'muted', text));
  if (action) box.append(action);
  return box;
}

function button(text, onClick, className = 'button') {
  const b = el('button', className, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

await render();
