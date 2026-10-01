// My tickets: every booking of the logged-in user, grouped as upcoming, awaiting payment and
// past, with the QR codes one click away (the same ones the confirmation email carries).
import { money, when } from './format.js';
import { mountHeader } from './header.js';
import { api, describeError, restoreSession, session, withNext } from './session.js';

const $ = (id) => document.getElementById(id);
const list = $('bookings');

mountHeader({ active: 'tickets', onLogout: () => location.assign('/') });

const STATUS_TEXT = {
  confirmed: 'Confirmed',
  pending: 'Awaiting payment',
  expired: 'Hold expired',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
};

async function load() {
  if (!(await restoreSession())) {
    location.replace(withNext('/login', '/my-tickets'));
    return;
  }
  const bookings = [];
  let cursor = null;
  // Your bookings, newest first, a page at a time (at most 5 pages here).
  for (let i = 0; i < 5; i++) {
    const page = await api(`/bookings?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    bookings.push(...page.data);
    cursor = page.page.nextCursor;
    if (!cursor) break;
  }

  const now = Date.now();
  const upcoming = bookings.filter((b) => b.status === 'confirmed' && Date.parse(b.event.startsAt) > now);
  const awaiting = bookings.filter((b) => b.status === 'pending' && Date.parse(b.expiresAt) > now);
  const past = bookings.filter((b) => !upcoming.includes(b) && !awaiting.includes(b));
  upcoming.sort((a, b) => Date.parse(a.event.startsAt) - Date.parse(b.event.startsAt));

  if (!bookings.length) {
    const empty = el('div', 'empty');
    const browse = el('a', 'button', 'Browse events');
    browse.href = '/';
    empty.append(
      el('h2', '', 'No tickets yet'),
      el('p', 'muted', 'When you book, your tickets show up here.'),
      browse,
    );
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(
    ...[
      group('Awaiting payment', awaiting),
      group('Upcoming', upcoming),
      group('Past and other bookings', past),
    ].filter(Boolean),
  );
}

function group(title, bookings) {
  if (!bookings.length) return null;
  const section = el('section', 'booking-group');
  section.append(el('h2', '', title), ...bookings.map(bookingCard));
  return section;
}

function bookingCard(b) {
  const card = el('article', 'booking');
  const top = el('div', 'booking-top');
  const info = el('div');
  const heading = el('h3');
  const link = el('a', '', b.event.title);
  link.href = `/events/${b.event.id}`;
  heading.append(link);
  const seats = b.items.map((i) => `${i.section} ${i.row}${i.number}`).join(', ');
  info.append(
    heading,
    el('p', 'muted', `${when(b.event.startsAt, b.event.timezone)} · ${b.event.venueName}`),
    el('p', '', `${b.items.length} seat${b.items.length === 1 ? '' : 's'}: ${seats}`),
    el('p', 'muted', `${money(b.totalCents, b.currency)} · Booking ${b.id.slice(0, 8)}`),
  );
  const tone = b.status === 'confirmed' ? 'confirmed' : b.status === 'pending' ? 'pending' : 'ended';
  top.append(info, el('span', `status-pill ${tone}`, STATUS_TEXT[b.status] ?? b.status));
  card.append(top);

  const actions = el('div', 'booking-actions');
  if (b.status === 'confirmed') {
    const show = el('button', '', 'Show tickets');
    show.type = 'button';
    const tickets = el('div', 'ticket-grid');
    tickets.hidden = true;
    show.addEventListener('click', async () => {
      if (!tickets.hidden) {
        tickets.hidden = true;
        show.textContent = 'Show tickets';
        return;
      }
      show.disabled = true;
      try {
        if (!tickets.children.length)
          tickets.append(...(await api(`/bookings/${b.id}/tickets`)).map(qrTicket));
        tickets.hidden = false;
        show.textContent = 'Hide tickets';
      } catch (err) {
        tickets.replaceChildren(el('p', 'message', describeError(err)));
        tickets.hidden = false;
      } finally {
        show.disabled = false;
      }
    });
    actions.append(show);
    card.append(actions, tickets);
    card.append(el('p', 'muted', `Also emailed to ${session.user.email}.`));
  } else if (b.status === 'pending') {
    const pay = el('a', 'button', 'Complete payment');
    pay.href = `/events/${b.event.id}`;
    actions.append(pay);
    card.append(actions);
  }
  return card;
}

function qrTicket(t) {
  const box = el('div', 'qr-ticket');
  const img = el('img');
  img.src = t.qr;
  img.alt = `QR code for ${t.seat.section}, row ${t.seat.row}, seat ${t.seat.number}`;
  box.append(img, el('strong', '', `${t.seat.section} · Row ${t.seat.row} · Seat ${t.seat.number}`));
  if (t.checkedInAt) box.append(el('span', 'muted', 'Used at the door'));
  return box;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

await load().catch((err) => {
  list.replaceChildren(el('p', 'message', describeError(err)));
});
