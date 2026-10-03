import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/index.js';
import {
  createEvent,
  createUser,
  createVenue,
  payFor,
  publish,
  runQueuedJobs,
  useApp,
  type TestUser,
} from '../helpers.js';

/**
 * The organizer dashboard's numbers, against bookings whose money we know. The default test
 * venue: Floor 2 rows × 5 seats at $80, Balcony 1 × 4 at $45 (14 seats).
 */
describe('organizer dashboard', () => {
  const t = useApp();
  let organizer: TestUser;
  let eventId: string;
  let floor: number[];
  let balcony: number[];

  beforeEach(async () => {
    organizer = await createUser('organizer');
    const venueId = (await createVenue(t.app, organizer)).id;
    eventId = (await createEvent(t.app, organizer, venueId)).json().id;
    await publish(t.app, organizer, eventId);
    const map = (await t.app.inject({ url: `/api/v1/events/${eventId}/seats` })).json();
    floor = map.sections[0].seats.map((s: { id: number }) => s.id);
    balcony = map.sections[1].seats.map((s: { id: number }) => s.id);
  });

  const hold = async (user: TestUser, seatIds: number[]) =>
    (
      await t.app.inject({
        method: 'POST',
        url: `/api/v1/events/${eventId}/bookings`,
        headers: user.auth,
        payload: { seatIds },
      })
    ).json<{ id: string }>().id;

  const buy = async (user: TestUser, seatIds: number[]) => {
    const bookingId = await hold(user, seatIds);
    await payFor(t.app, user, bookingId);
    return bookingId;
  };

  const get = (url: string, user?: TestUser) => t.app.inject({ url, headers: user?.auth });

  /** Ada buys two Floor seats; Ben buys a Balcony seat and gets a refund; Cy holds one. */
  async function sellSome() {
    const [ada, ben, cy] = await Promise.all([
      createUser('attendee'),
      createUser('attendee'),
      createUser('attendee'),
    ]);
    await db.updateTable('users').set({ name: 'Ada Lovelace' }).where('id', '=', ada.id).execute();
    await db.updateTable('users').set({ name: 'Ben Okafor' }).where('id', '=', ben.id).execute();
    const adaBooking = await buy(ada, floor.slice(0, 2));
    const benBooking = await buy(ben, [balcony[0]!]);
    const refund = await t.app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${benBooking}/refund`,
      headers: ben.auth,
    });
    expect(refund.statusCode).toBe(202);
    await runQueuedJobs();
    await hold(cy, [floor[5]!]);
    return { ada, ben, adaBooking };
  }

  it('adds up seats, money, bookings and check-ins exactly', async () => {
    const { ada, adaBooking } = await sellSome();
    const [ticket] = (await get(`/api/v1/bookings/${adaBooking}/tickets`, ada)).json<{ token: string }[]>();
    await t.app.inject({
      method: 'POST',
      url: '/api/v1/check-in',
      headers: organizer.auth,
      payload: { token: ticket!.token },
    });

    const res = await get(`/api/v1/events/${eventId}/stats`, organizer);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      eventId,
      currency: 'USD',
      seats: { total: 14, sold: 2, held: 1, available: 11 },
      // $160 + $45 charged; the $45 refunded.
      revenue: { collectedCents: 20_500, refundedCents: 4_500, netCents: 16_000 },
      bookings: { confirmed: 1, refunded: 1, pending: 1, cancelled: 0, expired: 0 },
      checkedIn: 1,
    });
  });

  it('charts sales over time, by 5 minutes, hour or day; a refund takes its sale out', async () => {
    await sellSome();
    for (const bucket of ['5m', '1h', '1d']) {
      const { sales } = (await get(`/api/v1/events/${eventId}/stats?bucket=${bucket}`, organizer)).json();
      expect(sales.bucket).toBe(bucket);
      expect(sales.points).toEqual([{ at: expect.any(String), tickets: 2, revenueCents: 16_000 }]);
    }
    const { sales } = (await get(`/api/v1/events/${eventId}/stats?bucket=1h`, organizer)).json();
    expect(new Date(sales.points[0].at).getUTCMinutes()).toBe(0); // an hour boundary
  });

  it('lists your events with their numbers; other organizers see none of them', async () => {
    await sellSome();
    const draftId = (
      await createEvent(t.app, organizer, (await createVenue(t.app, organizer)).id, { title: 'Next Season' })
    ).json().id;

    const mine = (await get('/api/v1/organizer/events', organizer)).json().data;
    expect(mine.map((e: { id: string }) => e.id).sort()).toEqual([eventId, draftId].sort());
    expect(mine.find((e: { id: string }) => e.id === eventId)).toMatchObject({
      status: 'published',
      seats: { total: 14, sold: 2 },
      revenueCents: 16_000,
      checkedIn: 0,
    });
    expect(mine.find((e: { id: string }) => e.id === draftId)).toMatchObject({
      status: 'draft',
      revenueCents: 0,
    });

    expect((await get('/api/v1/organizer/events', await createUser('organizer'))).json().data).toEqual([]);
    expect((await get('/api/v1/organizer/events', await createUser('admin'))).json().data).toHaveLength(2);
    expect((await get('/api/v1/organizer/events', await createUser('attendee'))).statusCode).toBe(403);
  });

  it('pages through attendees by name, and searches them', async () => {
    await sellSome();
    const first = (await get(`/api/v1/events/${eventId}/attendees?limit=1`, organizer)).json();
    expect(first.data).toHaveLength(1);
    expect(first.data[0]).toMatchObject({ name: 'Ada Lovelace', seat: { section: 'Floor', row: 'A' } });
    const second = (
      await get(`/api/v1/events/${eventId}/attendees?limit=1&cursor=${first.page.nextCursor}`, organizer)
    ).json();
    expect(second.data[0].name).toBe('Ada Lovelace'); // her second seat
    expect(second.data[0].ticketId).not.toBe(first.data[0].ticketId);
    // Ben was refunded: his ticket is void, so he isn't an attendee. Two tickets, two pages.
    expect(second.page.nextCursor).toBeNull();

    const search = (await get(`/api/v1/events/${eventId}/attendees?q=lovelace`, organizer)).json();
    expect(search.data).toHaveLength(2);
    expect((await get(`/api/v1/events/${eventId}/attendees?q=nobody`, organizer)).json().data).toEqual([]);
  });

  it('exports attendees as CSV that no spreadsheet will run as a formula', async () => {
    const { ada } = await sellSome();
    await db
      .updateTable('users')
      .set({ name: '=HYPERLINK("https://evil.example","Click")' })
      .where('id', '=', ada.id)
      .execute();

    const res = await get(`/api/v1/events/${eventId}/attendees.csv`, organizer);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="test-concert-attendees.csv"');
    expect(res.body.startsWith('\uFEFFName,Email,Section,Row,Seat,Booking,')).toBe(true);
    const lines = res.body.trim().split('\r\n');
    expect(lines).toHaveLength(3); // header + Ada's two tickets
    expect(lines[1]).toMatch(
      /^"'=HYPERLINK\(""https:\/\/evil\.example"",""Click""\)",user\d+@example\.com,Floor,A,[12],/,
    );
    expect(lines[1]).toMatch(/,\d{4}-\d{2}-\d{2} \d{2}:\d{2},$/); // purchased, venue time; not checked in
  });

  it('shows the numbers only to the event organizer and admins', async () => {
    const other = await createUser('organizer');
    for (const path of ['stats', 'attendees', 'attendees.csv']) {
      const url = `/api/v1/events/${eventId}/${path}`;
      expect((await get(url, other)).statusCode, path).toBe(403);
      expect((await get(url, await createUser('attendee'))).statusCode, path).toBe(403);
      expect((await get(url)).statusCode, path).toBe(401);
      expect((await get(url, await createUser('admin'))).statusCode, path).toBe(200);
    }
    // Someone else's draft doesn't exist, as far as you can tell.
    const draft = (await createEvent(t.app, other, (await createVenue(t.app, other)).id)).json().id;
    expect((await get(`/api/v1/events/${draft}/stats`, organizer)).statusCode).toBe(404);
  });
});
