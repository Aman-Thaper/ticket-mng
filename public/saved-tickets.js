// Keeping the signed-in user's tickets on this device: My tickets saves them every time it
// loads, and the event page right after a purchase. See offline-store.js for where they live.
import { saveTickets } from './offline-store.js';
import { api } from './session.js';

/** Confirmed, and the event hasn't ended: its tickets may be needed at the door. */
export const isUpcoming = (booking, now = Date.now()) =>
  booking.status === 'confirmed' && Date.parse(booking.event.endsAt) > now;

/** The user's bookings, newest first, a page at a time (at most 5 pages of 50). */
export async function fetchBookings() {
  const bookings = [];
  let cursor = null;
  for (let i = 0; i < 5; i++) {
    const page = await api(`/bookings?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    bookings.push(...page.data);
    cursor = page.page.nextCursor;
    if (!cursor) break;
  }
  return bookings;
}

/** Fetch the QR tickets of upcoming bookings and save everything on this device. */
export async function fetchAndSaveTickets(user, bookings) {
  const upcoming = bookings.filter((b) => isUpcoming(b)).slice(0, 20);
  const tickets = Object.fromEntries(
    await Promise.all(upcoming.map(async (b) => [b.id, await api(`/bookings/${b.id}/tickets`)])),
  );
  await saveTickets({
    userId: user.id,
    email: user.email,
    savedAt: new Date().toISOString(),
    bookings,
    tickets,
  });
  return tickets;
}

/** Refresh the saved copy in the background. A failure only means the old copy stays. */
export async function refreshSavedTickets(user) {
  try {
    await fetchAndSaveTickets(user, await fetchBookings());
  } catch {
    // offline or a server hiccup: try again next time
  }
}
