import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/index.js';
import { checkInvariants } from '../../src/lib/invariants.js';
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

describe('business invariants', () => {
  const t = useApp();
  let organizer: TestUser;
  let eventId: string;
  let seatIds: number[];

  const hold = (user: TestUser, seats: number[]) =>
    t.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/bookings`,
      headers: user.auth,
      payload: { seatIds: seats },
    });

  beforeEach(async () => {
    organizer = await createUser('organizer');
    const venueId = (await createVenue(t.app, organizer)).id;
    eventId = (await createEvent(t.app, organizer, venueId)).json().id;
    await publish(t.app, organizer, eventId);
    const map = (await t.app.inject({ url: `/api/v1/events/${eventId}/seats` })).json();
    seatIds = map.sections.flatMap((s: { seats: { id: number }[] }) => s.seats.map((seat) => seat.id));
  });

  it('hold after a busy mix of concurrent holds, payments, a late payment and a refund', async () => {
    const buyers = await Promise.all(Array.from({ length: 12 }, () => createUser('attendee')));
    // Everyone fights over the first 3 seats at once.
    const results = await Promise.all(buyers.map((b, i) => hold(b, [seatIds[i % 3]!])));
    const winners = results
      .map((r, i) => ({ res: r, buyer: buyers[i]! }))
      .filter((x) => x.res.statusCode === 201);
    expect(winners.length).toBeLessThanOrEqual(3);

    // The winners pay; one of them asks for a refund afterwards.
    for (const w of winners) await payFor(t.app, w.buyer, w.res.json().id);
    if (winners[0]) {
      await t.app.inject({
        method: 'POST',
        url: `/api/v1/bookings/${winners[0].res.json().id}/refund`,
        headers: winners[0].buyer.auth,
      });
      await runQueuedJobs();
    }

    // A late payment whose seat went to someone else: refunded automatically.
    const late = buyers[11]!;
    const lateBooking = (await hold(late, [seatIds[5]!])).json();
    const payment = (
      await t.app.inject({
        method: 'POST',
        url: `/api/v1/bookings/${lateBooking.id}/payment`,
        headers: late.auth,
      })
    ).json();
    await db
      .updateTable('bookings')
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where('id', '=', lateBooking.id)
      .execute();
    await hold(buyers[10]!, [seatIds[5]!]);
    await t.app.inject({
      method: 'POST',
      url: `/fake-gateway/v1/payment_intents/${payment.providerPaymentId}/confirm`,
      payload: { clientSecret: payment.clientSecret, cardNumber: '4242424242424242' },
    });
    await runQueuedJobs();

    expect(await checkInvariants(db)).toEqual([]);
  });

  it('catches corruption: a seat in two active bookings, and money kept for nothing', async () => {
    const [a, b] = await Promise.all([createUser('attendee'), createUser('attendee')]);
    const first = (await hold(a, [seatIds[0]!])).json();
    const second = (await hold(b, [seatIds[1]!])).json();
    // Corrupt on purpose: make the second booking also claim the first booking's seat.
    await db
      .insertInto('bookingItems')
      .values({ bookingId: second.id, eventSeatId: seatIds[0]!, priceCents: 1 })
      .execute();
    // And a "succeeded" payment on a booking that was never confirmed, with no refund.
    await db
      .insertInto('payments')
      .values({
        bookingId: first.id,
        provider: 'fake',
        amountCents: 100,
        currency: 'USD',
        status: 'succeeded',
      })
      .execute();

    const names = (await checkInvariants(db)).map((v) => v.name);
    expect(names).toEqual(expect.arrayContaining(['seat_sold_twice', 'paid_but_nothing_delivered']));

    // Operators get the same audit over HTTP.
    const admin = await createUser('admin');
    const res = await t.app.inject({ url: '/api/v1/admin/invariants', headers: admin.auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
    expect(res.json().violations.map((v: { name: string }) => v.name)).toEqual(
      expect.arrayContaining(['seat_sold_twice', 'paid_but_nothing_delivered']),
    );
  });

  it('exposes the audit to admins only', async () => {
    const [admin, attendee] = await Promise.all([createUser('admin'), createUser('attendee')]);
    const audit = (user: TestUser) => t.app.inject({ url: '/api/v1/admin/invariants', headers: user.auth });

    const res = await audit(admin);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, violations: [] });
    expect(res.json().checked).toContain('seat_sold_twice');
    expect((await audit(organizer)).statusCode).toBe(403);
    expect((await audit(attendee)).statusCode).toBe(403);
  });
});
