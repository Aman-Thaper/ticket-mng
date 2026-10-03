// The organizer's home: every event they run, grouped by where it stands, with seats sold,
// money taken and (once doors open) check-ins. Numbers from GET /organizer/events.
import { count, money, when } from './format.js';
import { mountHeader } from './header.js';
import { api, describeError, logout, restoreSession, withNext } from './session.js';

const $ = (id) => document.getElementById(id);
mountHeader({ active: 'organizer', onLogout: () => location.assign('/') });

async function load() {
  const user = await restoreSession();
  if (!user) return location.replace(withNext('/login', '/organizer'));
  if (user.role === 'attendee') return notAnOrganizer();
  const { data } = await api('/organizer/events');
  render(data);
}

function render(events) {
  if (!events.length) {
    const empty = el('div', 'empty');
    const create = el('a', 'button', 'Create your first event');
    create.href = '/organizer/events/new';
    empty.append(
      el('h2', '', 'No events yet'),
      el('p', 'muted', 'Pick a venue, set the date and prices, and you can be selling tickets in minutes.'),
      create,
    );
    $('events').replaceChildren(empty);
    return;
  }
  const now = Date.now();
  const groups = [
    ['Drafts', events.filter((e) => e.status === 'draft')],
    ['Upcoming', events.filter((e) => e.status === 'published' && Date.parse(e.endsAt) > now)],
    ['Past', events.filter((e) => e.status === 'published' && Date.parse(e.endsAt) <= now).reverse()],
    ['Cancelled', events.filter((e) => e.status === 'cancelled')],
  ];
  $('events').replaceChildren(
    ...groups
      .filter(([, list]) => list.length)
      .map(([title, list]) => {
        const section = el('section', 'event-group');
        section.append(el('h2', '', `${title} (${list.length})`), ...list.map(row));
        return section;
      }),
  );
  renderTotals(events.filter((e) => e.status === 'published'));
}

function row(e) {
  const link = el('a', 'org-event');
  link.href = `/organizer/events/${e.id}`;
  const info = el('div');
  const heading = el('h3', '', e.title);
  info.append(
    heading,
    el('p', 'muted', `${when(e.startsAt, e.venue.timezone)} · ${e.venue.name}, ${e.venue.city}`),
  );

  const numbers = el('div', 'numbers');
  const pct = e.seats.total ? Math.round((100 * e.seats.sold) / e.seats.total) : 0;
  const meter = el('div', 'meter');
  const fill = el('span');
  fill.style.width = `${pct}%`;
  meter.append(fill);
  const started = Date.parse(e.startsAt) <= Date.now();
  numbers.append(
    el('span', '', `${count(e.seats.sold)} / ${count(e.seats.total)} sold · ${pct}%`),
    meter,
    ...(started && e.status === 'published' ? [el('span', 'muted', `${count(e.checkedIn)} checked in`)] : []),
  );

  const side = el('div', 'money');
  const status = el(
    'span',
    `status-pill ${e.status}`,
    e.status === 'published' ? 'On sale' : capitalize(e.status),
  );
  side.append(el('div', '', money(e.revenueCents, e.currency)), status);
  link.append(info, numbers, side);
  return link;
}

function renderTotals(published) {
  if (!published.length) return;
  const currencies = [...new Set(published.map((e) => e.currency))];
  const revenue = currencies
    .map((c) =>
      money(
        published.filter((e) => e.currency === c).reduce((sum, e) => sum + e.revenueCents, 0),
        c,
      ),
    )
    .join(' + ');
  const sold = published.reduce((sum, e) => sum + e.seats.sold, 0);
  const upcoming = published.filter((e) => Date.parse(e.endsAt) > Date.now()).length;
  $('totals').replaceChildren(
    stat('Events on sale', count(upcoming)),
    stat('Tickets sold', count(sold)),
    stat('Revenue', revenue),
  );
  $('totals').hidden = false;
}

function stat(label, value) {
  const card = el('div', 'stat-card');
  card.append(el('span', 'stat-label', label), el('strong', '', value));
  return card;
}

function notAnOrganizer() {
  $('create').hidden = true;
  const box = el('div', 'empty');
  const signup = el('button', '', 'Log out and create an organizer account');
  signup.type = 'button';
  signup.addEventListener('click', async () => {
    await logout();
    location.assign('/signup?role=organizer');
  });
  box.append(
    el('h2', '', 'This is where organizers run their events'),
    el(
      'p',
      'muted',
      'Your account is for buying tickets. To sell them, create an organizer account with another email.',
    ),
    signup,
  );
  $('events').replaceChildren(box);
}

const capitalize = (s) => s[0].toUpperCase() + s.slice(1);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

await load().catch((err) => $('events').replaceChildren(el('p', 'message', describeError(err))));
