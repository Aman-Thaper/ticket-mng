// My tickets: every booking of the logged-in user, grouped as upcoming, awaiting payment and
// past, with the QR codes one click away (the same ones the confirmation email carries).
//
// It works offline: each load saves the upcoming tickets on this device (saved-tickets.js),
// and without a connection the page shows that saved copy, QR codes and all. Upcoming
// events can also be added to a calendar (.ics file, or Google Calendar).
import { money, when } from './format.js';
import { mountHeader } from './header.js';
import { clearSavedTickets, loadSavedTickets } from './offline-store.js';
import { fetchAndSaveTickets, fetchBookings, isUpcoming } from './saved-tickets.js';
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
  const user = await restoreSession();
  if (!user) {
    if (session.offline) return showSaved();
    await clearSavedTickets(); // not signed in: nothing of anyone's stays on the device
    location.replace(withNext('/login', '/my-tickets'));
    return;
  }
  let bookings;
  let tickets;
  try {
    bookings = await fetchBookings();
    tickets = await fetchAndSaveTickets(user, bookings);
  } catch (err) {
    if (err instanceof TypeError) return showSaved(); // the connection dropped midway
    throw err;
  }
  render(bookings, tickets, { email: user.email, offline: false });
}

/** No connection: the copy saved on this device, if there is one. */
async function showSaved() {
  const saved = await loadSavedTickets();
  const banner = el('p', 'offline-banner');
  banner.setAttribute('role', 'status');
  if (saved) {
    const savedAt = new Date(saved.savedAt).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    banner.textContent = `You're offline. These tickets were saved on this device on ${savedAt}. The QR codes work at the door without a connection.`;
    render(saved.bookings, saved.tickets, { email: saved.email, offline: true });
    list.prepend(banner);
  } else {
    banner.textContent =
      "You're offline, and no tickets are saved on this device yet. Open My tickets once with a connection, and they'll be here next time.";
    list.replaceChildren(banner);
  }
  // Back online: show the live version.
  window.addEventListener('online', () => void load().catch(showError), { once: true });
}

function render(bookings, tickets, options) {
  const now = Date.now();
  const upcoming = bookings.filter((b) => isUpcoming(b, now));
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
  const card = (b) => bookingCard(b, tickets[b.id], { ...options, upcoming: upcoming.includes(b) });
  list.replaceChildren(
    ...[
      group('Awaiting payment', awaiting, card),
      group('Upcoming', upcoming, card),
      group('Past and other bookings', past, card),
    ].filter(Boolean),
  );
}

function group(title, bookings, card) {
  if (!bookings.length) return null;
  const section = el('section', 'booking-group');
  section.append(el('h2', '', title), ...bookings.map(card));
  return section;
}

function bookingCard(b, savedTickets, { email, offline, upcoming }) {
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
    const show = button('Show tickets');
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
        if (!tickets.children.length) {
          if (savedTickets) tickets.append(...savedTickets.map(qrTicket));
          else if (offline) tickets.append(el('p', 'muted', 'These tickets aren’t saved on this device.'));
          else tickets.append(...(await api(`/bookings/${b.id}/tickets`)).map(qrTicket));
        }
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
    if (upcoming && !offline) {
      const add = button('Add to calendar', 'secondary');
      add.addEventListener('click', () => void addToCalendar(b, add, card));
      const google = el('a', 'calendar-link', 'Google Calendar ↗');
      google.href = googleCalendarUrl(b);
      google.target = '_blank';
      google.rel = 'noopener';
      actions.append(add, google);
    }
    card.append(actions, tickets);
    card.append(el('p', 'muted', `Also emailed to ${email}.`));
  } else if (b.status === 'pending' && !offline) {
    const pay = el('a', 'button', 'Complete payment');
    pay.href = `/events/${b.event.id}`;
    actions.append(pay);
    card.append(actions);
  }
  return card;
}

/** Download the booking's .ics file. (A plain link can't send the access token, so: fetch, then save.) */
async function addToCalendar(b, trigger, card) {
  trigger.disabled = true;
  try {
    const file = await api(`/bookings/${b.id}/calendar.ics`, { responseType: 'blob' });
    const url = URL.createObjectURL(file);
    const a = el('a');
    a.href = url;
    a.download = `${slug(b.event.title)}.ics`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (err) {
    card.append(el('p', 'message', describeError(err)));
  } finally {
    trigger.disabled = false;
  }
}

/** Google Calendar's "create event" page, filled in. Nothing is sent until the user saves it there. */
function googleCalendarUrl(b) {
  const utc = (iso) =>
    new Date(iso)
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');
  const seats = b.items.map((i) => `${i.section}, row ${i.row}, seat ${i.number}`).join('; ');
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: b.event.title,
    dates: `${utc(b.event.startsAt)}/${utc(b.event.endsAt)}`,
    location: `${b.event.venueName}, ${b.event.city}`,
    details: `Your seats: ${seats}\nYour QR tickets: ${location.origin}/my-tickets`,
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

/** Same file name as the server gives it: "Hamlet: The Musical!" → "hamlet-the-musical". */
const slug = (title) =>
  title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'event';

function qrTicket(t) {
  const box = el('div', 'qr-ticket');
  const img = el('img');
  img.src = t.qr;
  img.alt = `QR code for ${t.seat.section}, row ${t.seat.row}, seat ${t.seat.number}`;
  box.append(img, el('strong', '', `${t.seat.section} · Row ${t.seat.row} · Seat ${t.seat.number}`));
  if (t.checkedInAt) box.append(el('span', 'muted', 'Used at the door'));
  return box;
}

function button(text, className = '') {
  const b = el('button', className, text);
  b.type = 'button';
  return b;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showError(err) {
  list.replaceChildren(el('p', 'message', describeError(err)));
}

await load().catch(showError);
