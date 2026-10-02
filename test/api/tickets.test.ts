import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/index.js';
import { signTicket } from '../../src/modules/tickets/signing.js';
import { createEvent, createUser, createVenue, payFor, publish, useApp, type TestUser } from '../helpers.js';

describe('tickets and check-in', () => {
  const t = useApp();
  let organizer: TestUser;
  let buyer: TestUser;
  let eventId: string;
  let bookingId: string;
  let tickets: Array<{
    id: string;
    token: string;
    qr: string;
    seat: { section: string; row: string; number: number };
  }>;

  const scan = (user: TestUser, token: string, scannedAt?: string) =>
    t.app.inject({
      method: 'POST',
      url: '/api/v1/check-in',
      headers: user.auth,
      payload: { token, ...(scannedAt ? { scannedAt } : {}) },
    });

  const attendance = (user?: TestUser, headers: Record<string, string> = {}) =>
    t.app.inject({ url: `/api/v1/events/${eventId}/attendance`, headers: { ...user?.auth, ...headers } });

  beforeEach(async () => {
    [organizer, buyer] = await Promise.all([createUser('organizer'), createUser('attendee')]);
    const venueId = (await createVenue(t.app, organizer)).id;
    eventId = (await createEvent(t.app, organizer, venueId)).json().id;
    await publish(t.app, organizer, eventId);
    const map = (await t.app.inject({ url: `/api/v1/events/${eventId}/seats` })).json();
    const seatIds = map.sections[0].seats.slice(0, 2).map((s: { id: number }) => s.id);

    bookingId = (
      await t.app.inject({
        method: 'POST',
        url: `/api/v1/events/${eventId}/bookings`,
        headers: buyer.auth,
        payload: { seatIds },
      })
    ).json().id;
    await payFor(t.app, buyer, bookingId);
    tickets = (
      await t.app.inject({ url: `/api/v1/bookings/${bookingId}/tickets`, headers: buyer.auth })
    ).json();
  });

  it('issues one ticket per seat on confirmation, each with a QR code', () => {
    expect(tickets).toHaveLength(2);
    expect(tickets[0]).toMatchObject({ status: 'valid', seat: { section: 'Floor', row: 'A', number: 1 } });
    expect(tickets[0]!.qr).toMatch(/^data:image\/png;base64,/);
  });

  it('only the buyer can fetch the tickets', async () => {
    const res = await t.app.inject({
      url: `/api/v1/bookings/${bookingId}/tickets`,
      headers: (await createUser('attendee')).auth,
    });
    expect(res.statusCode).toBe(404);
  });

  it('admits a ticket once; the second scan is rejected with the time of the first', async () => {
    const first = await scan(organizer, tickets[0]!.token);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ seat: { row: 'A', number: 1 }, holder: expect.any(String) });

    const second = await scan(organizer, tickets[0]!.token);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toMatchObject({
      code: 'ALREADY_CHECKED_IN',
      details: { checkedInAt: first.json().checkedInAt },
    });
  });

  it('two scanners reading the same code at the same instant admit it exactly once', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => scan(organizer, tickets[1]!.token)));
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, ...Array(9).fill(409)]);
  });

  it('rejects forged tickets without touching the database', async () => {
    const [payload] = tickets[0]!.token.split('.');
    const forged = await scan(organizer, `${payload}.${'A'.repeat(86)}`);
    expect(forged.statusCode).toBe(400);
    expect(forged.json().error.code).toBe('INVALID_TICKET');
  });

  it('only the event organizer (or an admin) can check tickets in', async () => {
    expect((await scan(await createUser('organizer'), tickets[0]!.token)).statusCode).toBe(403);
    expect((await scan(buyer, tickets[0]!.token)).statusCode).toBe(403);
    expect((await scan(await createUser('admin'), tickets[0]!.token)).statusCode).toBe(200);
  });

  it('rejects void tickets', async () => {
    await db.updateTable('tickets').set({ status: 'void' }).where('id', '=', tickets[0]!.id).execute();
    const res = await scan(organizer, tickets[0]!.token);
    expect(res.json().error.code).toBe('TICKET_VOID');
  });

  it('a genuine signature for a ticket that does not exist is a 404', async () => {
    const token = signTicket({
      ticketId: '11111111-1111-4111-8111-111111111111',
      eventId: '22222222-2222-4222-8222-222222222222',
    });
    expect((await scan(organizer, token)).statusCode).toBe(404);
  });

  it('the database refuses a second valid ticket for the same seat (last line of defence)', async () => {
    const existing = await db
      .selectFrom('tickets')
      .selectAll()
      .where('id', '=', tickets[0]!.id)
      .executeTakeFirstOrThrow();
    await expect(
      db
        .insertInto('tickets')
        .values({
          bookingId: existing.bookingId,
          eventId: existing.eventId,
          eventSeatId: existing.eventSeatId,
        })
        .execute(),
    ).rejects.toMatchObject({ code: '23505', constraint: 'tickets_one_valid_per_seat' });
  });

  it('keeps the real time of a scan made offline and synced later', async () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    const synced = await scan(organizer, tickets[0]!.token, tenMinutesAgo);
    expect(synced.statusCode).toBe(200);
    expect(synced.json().checkedInAt).toBe(tenMinutesAgo);

    // Too old to be a scanner coming back online: rejected. A fast clock can't post-date a scan.
    const tooOld = await scan(
      organizer,
      tickets[1]!.token,
      new Date(Date.now() - 25 * 3_600_000).toISOString(),
    );
    expect(tooOld.json().error.code).toBe('VALIDATION_ERROR');
    const fromTheFuture = await scan(
      organizer,
      tickets[1]!.token,
      new Date(Date.now() + 60_000).toISOString(),
    );
    expect(Date.parse(fromTheFuture.json().checkedInAt)).toBeLessThanOrEqual(Date.now());
  });

  it('reports live attendance: tickets sold, checked in, and the latest scans first', async () => {
    expect((await attendance(organizer)).json()).toEqual({ eventId, sold: 2, checkedIn: 0, recent: [] });

    await scan(organizer, tickets[0]!.token, new Date(Date.now() - 60_000).toISOString());
    await scan(organizer, tickets[1]!.token);
    const res = await attendance(organizer);
    expect(res.headers['cache-control']).toBe('private, no-cache');
    expect(res.json()).toMatchObject({
      sold: 2,
      checkedIn: 2,
      recent: [
        { ticketId: tickets[1]!.id, seat: { row: 'A', number: 2 }, holder: expect.any(String) },
        { ticketId: tickets[0]!.id, seat: { row: 'A', number: 1 } },
      ],
    });
    // Scanners poll every few seconds: nothing new costs a 304.
    expect((await attendance(organizer, { 'if-none-match': res.headers.etag as string })).statusCode).toBe(
      304,
    );

    // A refunded ticket no longer counts, even if it was scanned.
    await db.updateTable('tickets').set({ status: 'void' }).where('id', '=', tickets[0]!.id).execute();
    expect((await attendance(organizer)).json()).toMatchObject({ sold: 1, checkedIn: 1 });
  });

  it('shows attendance only to the event organizer and admins', async () => {
    expect((await attendance(await createUser('organizer'))).statusCode).toBe(403);
    expect((await attendance(buyer)).statusCode).toBe(403);
    expect((await attendance()).statusCode).toBe(401);
    expect((await attendance(await createUser('admin'))).statusCode).toBe(200);
    const missing = await t.app.inject({
      url: '/api/v1/events/00000000-0000-4000-8000-000000000000/attendance',
      headers: organizer.auth,
    });
    expect(missing.statusCode).toBe(404);
  });

  it('the published key verifies tickets with WebCrypto, as door scanners do offline', async () => {
    const { jwk } = (await t.app.inject({ url: '/api/v1/tickets/public-key' })).json<{ jwk: JsonWebKey }>();
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['verify']);
    const [payload, signature] = tickets[0]!.token.split('.').map((part) => Buffer.from(part, 'base64url'));
    expect(await crypto.subtle.verify('Ed25519', key, signature!, payload!)).toBe(true);
    // One flipped bit and it's not a ticket.
    payload![5]! ^= 1;
    expect(await crypto.subtle.verify('Ed25519', key, signature!, payload!)).toBe(false);
  });

  it('publishes the verification key', async () => {
    const res = await t.app.inject({ url: '/api/v1/tickets/public-key' });
    expect(res.json()).toMatchObject({
      algorithm: 'Ed25519',
      pem: expect.stringContaining('BEGIN PUBLIC KEY'),
      jwk: { kty: 'OKP', crv: 'Ed25519' },
    });
  });
});
