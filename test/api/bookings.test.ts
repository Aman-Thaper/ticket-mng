import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { db } from '../../src/db/index.js';
import { confirmBooking, expireBooking, type HoldStrategy } from '../../src/modules/bookings/service.js';
import { createEvent, createUser, createVenue, inDays, publish, useApp, type TestUser } from '../helpers.js';

describe('bookings', () => {
  const t = useApp();
  let organizer: TestUser;
  let buyer: TestUser;
  let eventId: string;
  let seatIds: number[];

  async function openEvent(overrides: Record<string, unknown> = {}) {
    const venueId = (await createVenue(t.app, organizer)).id;
    const id = (await createEvent(t.app, organizer, venueId, overrides)).json().id as string;
    await publish(t.app, organizer, id);
    const map = (await t.app.inject({ url: `/api/v1/events/${id}/seats` })).json();
    const ids: number[] = map.sections.flatMap((s: { seats: { id: number }[] }) =>
      s.seats.map((seat) => seat.id),
    );
    return { id, seatIds: ids };
  }

  const hold = (user: TestUser, seats: number[], event = eventId, app: FastifyInstance = t.app) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/events/${event}/bookings`,
      headers: user.auth,
      payload: { seatIds: seats },
    });

  const seatStatus = async (seatId: number) => {
    const map = (await t.app.inject({ url: `/api/v1/events/${eventId}/seats` })).json();
    for (const section of map.sections) {
      const seat = section.seats.find((s: { id: number }) => s.id === seatId);
      if (seat) return seat as { status: string; version: number };
    }
    throw new Error(`seat ${seatId} not in map`);
  };

  const lapse = (bookingId: string) =>
    db
      .updateTable('bookings')
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where('id', '=', bookingId)
      .execute();

  beforeEach(async () => {
    [organizer, buyer] = await Promise.all([createUser('organizer'), createUser('attendee')]);
    ({ id: eventId, seatIds } = await openEvent());
  });

  describe('holding seats', () => {
    it('holds seats as a pending booking with a 10-minute deadline and priced items', async () => {
      const res = await hold(buyer, [seatIds[0]!, seatIds[1]!]);
      expect(res.statusCode).toBe(201);
      const booking = res.json();
      expect(booking).toMatchObject({
        status: 'pending',
        totalCents: 16_000,
        currency: 'USD',
        userId: buyer.id,
      });
      expect(booking.items).toEqual([
        { seatId: seatIds[0], section: 'Floor', row: 'A', number: 1, priceCents: 8000 },
        { seatId: seatIds[1], section: 'Floor', row: 'A', number: 2, priceCents: 8000 },
      ]);
      const ttlMs = new Date(booking.expiresAt).getTime() - Date.now();
      expect(ttlMs).toBeGreaterThan(590_000);
      expect(ttlMs).toBeLessThanOrEqual(600_000);
      expect(res.headers.location).toBe(`/api/v1/bookings/${booking.id}`);

      expect(await seatStatus(seatIds[0]!)).toMatchObject({ status: 'held', version: 1 });
      const detail = (await t.app.inject({ url: `/api/v1/events/${eventId}` })).json();
      expect(detail.seats).toEqual({ total: 14, available: 12 });
    });

    it('refuses seats that are already held, naming them', async () => {
      await hold(buyer, [seatIds[0]!]);
      const res = await hold(await createUser('attendee'), [seatIds[1]!, seatIds[0]!]);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatchObject({
        code: 'SEATS_UNAVAILABLE',
        details: { seatIds: [seatIds[0]] },
      });
      expect(await seatStatus(seatIds[1]!)).toMatchObject({ status: 'available' }); // all or nothing
    });

    it('rejects unknown seats and seats of another event with 422', async () => {
      const other = await openEvent({ startsAt: inDays(30), endsAt: inDays(30, 2) });
      expect((await hold(buyer, [999_999])).json().error.code).toBe('UNKNOWN_SEATS');
      expect((await hold(buyer, [other.seatIds[0]!])).json().error.code).toBe('UNKNOWN_SEATS');
    });

    it('only sells published events inside the sales window', async () => {
      const venueId = (await createVenue(t.app, organizer)).id;
      const draft = (await createEvent(t.app, organizer, venueId)).json();
      expect((await hold(buyer, [1], draft.id)).statusCode).toBe(404);

      const later = (
        await createEvent(t.app, organizer, venueId, {
          startsAt: inDays(20),
          endsAt: inDays(20, 2),
          salesStartAt: inDays(1),
        })
      ).json();
      await publish(t.app, organizer, later.id);
      const early = await hold(buyer, [1], later.id);
      expect(early.statusCode).toBe(409);
      expect(early.json().error.code).toBe('SALES_NOT_STARTED');
    });

    it('allows one active hold per user per event', async () => {
      const first = (await hold(buyer, [seatIds[0]!])).json();
      const second = await hold(buyer, [seatIds[1]!]);
      expect(second.statusCode).toBe(409);
      expect(second.json().error).toMatchObject({ code: 'HOLD_EXISTS', details: { bookingId: first.id } });

      await t.app.inject({ method: 'POST', url: `/api/v1/bookings/${first.id}/cancel`, headers: buyer.auth });
      expect((await hold(buyer, [seatIds[1]!])).statusCode).toBe(201);
    });

    it('stops a double-click: concurrent holds by one user, exactly one succeeds', async () => {
      const results = await Promise.all(seatIds.slice(0, 5).map((id) => hold(buyer, [id])));
      const codes = results.map((r) => r.statusCode).sort();
      expect(codes).toEqual([201, 409, 409, 409, 409]);
    });

    it('enforces the per-user ticket limit across bookings', async () => {
      const limited = await openEvent({ startsAt: inDays(40), endsAt: inDays(40, 2), maxTicketsPerUser: 2 });
      expect((await hold(buyer, limited.seatIds.slice(0, 3), limited.id)).json().error.code).toBe(
        'TOO_MANY_SEATS',
      );

      const first = (await hold(buyer, limited.seatIds.slice(0, 2), limited.id)).json();
      await t.app.inject({
        method: 'POST',
        url: `/api/v1/bookings/${first.id}/confirm`,
        headers: buyer.auth,
      });
      const more = await hold(buyer, [limited.seatIds[2]!], limited.id);
      expect(more.json().error).toMatchObject({
        code: 'TICKET_LIMIT_EXCEEDED',
        details: { alreadyOwned: 2 },
      });
    });
  });

  describe('expiry', () => {
    it('treats seats of a lapsed hold as free immediately, without waiting for a job', async () => {
      const first = (await hold(buyer, [seatIds[0]!, seatIds[1]!])).json();
      await lapse(first.id);

      expect(await seatStatus(seatIds[0]!)).toMatchObject({ status: 'available' });
      const rival = await createUser('attendee');
      expect((await hold(rival, [seatIds[0]!])).statusCode).toBe(201);

      // The lapsed booking was marked expired by the hold that took its seat.
      const old = (await t.app.inject({ url: `/api/v1/bookings/${first.id}`, headers: buyer.auth })).json();
      expect(old.status).toBe('expired');
    });

    it('lets a user with a lapsed hold book again', async () => {
      const first = (await hold(buyer, [seatIds[0]!])).json();
      await lapse(first.id);
      expect((await hold(buyer, [seatIds[0]!])).statusCode).toBe(201);
    });

    it('expireBooking releases the seats and is idempotent', async () => {
      const booking = (await hold(buyer, [seatIds[0]!])).json();
      expect(await expireBooking(booking.id)).toEqual([]); // not lapsed yet: no-op

      await lapse(booking.id);
      const changes = await expireBooking(booking.id);
      expect(changes).toEqual([{ id: seatIds[0], status: 'available', version: 2 }]);
      expect(await expireBooking(booking.id)).toEqual([]);

      const row = await db
        .selectFrom('eventSeats')
        .selectAll()
        .where('id', '=', seatIds[0]!)
        .executeTakeFirstOrThrow();
      expect(row).toMatchObject({ status: 'available', bookingId: null });
    });
  });

  describe('confirm and cancel', () => {
    it('confirms a hold: seats become booked; confirming again is a no-op', async () => {
      const booking = (await hold(buyer, [seatIds[0]!])).json();
      const confirm = () =>
        t.app.inject({ method: 'POST', url: `/api/v1/bookings/${booking.id}/confirm`, headers: buyer.auth });

      const res = await confirm();
      expect(res.json()).toMatchObject({ status: 'confirmed', confirmedAt: expect.any(String) });
      expect(await seatStatus(seatIds[0]!)).toMatchObject({ status: 'booked' });
      expect((await confirm()).json().status).toBe('confirmed');
    });

    it('refuses to confirm a lapsed hold and releases its seats', async () => {
      const booking = (await hold(buyer, [seatIds[0]!])).json();
      await lapse(booking.id);
      const res = await t.app.inject({
        method: 'POST',
        url: `/api/v1/bookings/${booking.id}/confirm`,
        headers: buyer.auth,
      });
      expect(res.json().error.code).toBe('HOLD_EXPIRED');
      expect(
        (
          await db
            .selectFrom('eventSeats')
            .select('status')
            .where('id', '=', seatIds[0]!)
            .executeTakeFirstOrThrow()
        ).status,
      ).toBe('available');
    });

    it('cancels a pending booking and frees its seats; paid bookings need a refund instead', async () => {
      const booking = (await hold(buyer, [seatIds[0]!])).json();
      const cancel = () =>
        t.app.inject({ method: 'POST', url: `/api/v1/bookings/${booking.id}/cancel`, headers: buyer.auth });
      expect((await cancel()).json().status).toBe('cancelled');
      expect(await seatStatus(seatIds[0]!)).toMatchObject({ status: 'available' });
      expect((await cancel()).json().error.code).toBe('BOOKING_NOT_PENDING');
    });

    it('lets only the buyer mutate a booking; the organizer and admins can view it', async () => {
      const booking = (await hold(buyer, [seatIds[0]!])).json();
      const stranger = await createUser('attendee');
      const view = (user: TestUser) =>
        t.app.inject({ url: `/api/v1/bookings/${booking.id}`, headers: user.auth });

      expect((await view(stranger)).statusCode).toBe(404);
      expect((await view(organizer)).statusCode).toBe(200);
      expect((await view(await createUser('admin'))).statusCode).toBe(200);
      const hijack = await t.app.inject({
        method: 'POST',
        url: `/api/v1/bookings/${booking.id}/confirm`,
        headers: stranger.auth,
      });
      expect(hijack.statusCode).toBe(404);
    });

    it('voids holds when the organizer cancels the event', async () => {
      const booking = (await hold(buyer, [seatIds[0]!])).json();
      await t.app.inject({
        method: 'PATCH',
        url: `/api/v1/events/${eventId}`,
        headers: organizer.auth,
        payload: { status: 'cancelled' },
      });
      const after = (
        await t.app.inject({ url: `/api/v1/bookings/${booking.id}`, headers: buyer.auth })
      ).json();
      expect(after.status).toBe('cancelled');
      const seat = await db
        .selectFrom('eventSeats')
        .select(['status', 'bookingId'])
        .where('id', '=', seatIds[0]!)
        .executeTakeFirstOrThrow();
      expect(seat).toEqual({ status: 'available', bookingId: null });
      expect((await hold(buyer, [seatIds[1]!])).json().error.code).toBe('EVENT_CANCELLED');
    });

    it('lists your bookings newest first with a cursor', async () => {
      for (const id of seatIds.slice(0, 3)) {
        const b = (await hold(buyer, [id])).json();
        await t.app.inject({ method: 'POST', url: `/api/v1/bookings/${b.id}/cancel`, headers: buyer.auth });
      }
      const page1 = (await t.app.inject({ url: '/api/v1/bookings?limit=2', headers: buyer.auth })).json();
      expect(page1.data).toHaveLength(2);
      const page2 = (
        await t.app.inject({
          url: `/api/v1/bookings?limit=2&cursor=${page1.page.nextCursor}`,
          headers: buyer.auth,
        })
      ).json();
      expect(page2.data).toHaveLength(1);
      expect(page2.page.nextCursor).toBeNull();
      const all = [...page1.data, ...page2.data].map(
        (b: { items: { seatId: number }[] }) => b.items[0]!.seatId,
      );
      expect(all).toEqual([seatIds[2], seatIds[1], seatIds[0]]);
    });
  });

  describe('late payment (service level, used by the payment webhook)', () => {
    it('re-takes the seats when a payment lands after the hold lapsed and the seats are still free', async () => {
      const booking = (await hold(buyer, [seatIds[0]!])).json();
      await lapse(booking.id);
      await expireBooking(booking.id);

      expect(await confirmBooking(booking.id, { lateAllowed: true })).toMatchObject({
        kind: 'confirmed',
        late: true,
      });
      expect(await seatStatus(seatIds[0]!)).toMatchObject({ status: 'booked' });
    });

    it('reports seats_lost when someone else took them in the meantime (so the payment gets refunded)', async () => {
      const booking = (await hold(buyer, [seatIds[0]!])).json();
      await lapse(booking.id);
      await hold(await createUser('attendee'), [seatIds[0]!]);
      expect(await confirmBooking(booking.id, { lateAllowed: true })).toEqual({ kind: 'seats_lost' });
    });
  });

  describe.each<HoldStrategy>(['pessimistic', 'optimistic', 'serializable'])(
    'concurrency with the %s strategy',
    (strategy) => {
      it('30 buyers race for one seat: exactly one wins, the rest get a clean 409', async () => {
        // Gate off, so every attempt really reaches the database transaction.
        const app = await buildApp({ logger: false }, { booking: { strategy, claimGate: false } });
        try {
          const buyers = await Promise.all(Array.from({ length: 30 }, () => createUser('attendee')));
          const results = await Promise.all(buyers.map((b) => hold(b, [seatIds[0]!], eventId, app)));
          const codes = results.map((r) => r.statusCode);
          expect(
            codes.filter((c) => c === 201),
            `codes: ${codes.join(',')}`,
          ).toHaveLength(1);
          expect(
            codes.filter((c) => c === 409),
            `codes: ${codes.join(',')}`,
          ).toHaveLength(29);

          const holders = await db
            .selectFrom('bookingItems as bi')
            .innerJoin('bookings as b', 'b.id', 'bi.bookingId')
            .where('bi.eventSeatId', '=', seatIds[0]!)
            .where('b.status', '=', 'pending')
            .select((eb) => eb.fn.countAll<number>().as('n'))
            .executeTakeFirstOrThrow();
          expect(holders.n).toBe(1);
        } finally {
          await app.close();
        }
      });
    },
  );

  it('the claim gate turns away concurrent attempts before they reach the database', async () => {
    const buyers = await Promise.all(Array.from({ length: 30 }, () => createUser('attendee')));
    const results = await Promise.all(buyers.map((b) => hold(b, [seatIds[0]!])));
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(29);
  });
});
