import { beforeEach, describe, expect, it } from 'vitest';
import { createEvent, createUser, createVenue, publish, useApp, type TestUser } from '../helpers.js';

/** "Best available" over HTTP. The default test venue: Floor 2 rows × 5 seats ($80), Balcony 1 × 4 ($45). */
describe('best available seats', () => {
  const t = useApp();
  let eventId: string;

  beforeEach(async () => {
    const organizer = await createUser('organizer');
    const venueId = (await createVenue(t.app, organizer)).id;
    eventId = (await createEvent(t.app, organizer, venueId)).json().id;
    await publish(t.app, organizer, eventId);
  });

  const best = (user: TestUser, body: object) =>
    t.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/bookings/best`,
      headers: user.auth,
      payload: body,
    });

  type Item = { section: string; row: string; number: number; priceCents: number };

  it('holds adjacent seats in the front row without stranding a single seat', async () => {
    const res = await best(await createUser('attendee'), { quantity: 3 });
    expect(res.statusCode).toBe(201);
    const items: Item[] = res.json().items;
    expect(res.json().status).toBe('pending');
    expect(new Set(items.map((i) => `${i.section} ${i.row}`))).toEqual(new Set(['Floor A']));
    const numbers = items.map((i) => i.number).sort((a, b) => a - b);
    expect(numbers[2]! - numbers[0]!).toBe(2); // side by side
    // Row A has 5 seats: the block sits at one end, leaving 2 together rather than 1 + 1.
    expect([numbers[0]! - 1, 5 - numbers[2]!]).toContain(0); // seats left of it, seats right of it
  });

  it('respects the price limit', async () => {
    const res = await best(await createUser('attendee'), { quantity: 2, maxPriceCents: 5000 });
    expect(res.statusCode).toBe(201);
    expect(res.json().items.every((i: Item) => i.section === 'Balcony' && i.priceCents === 4500)).toBe(true);
  });

  it('answers 409 NO_SEATS_TOGETHER when no block fits', async () => {
    const res = await best(await createUser('attendee'), { quantity: 6 }); // rows hold at most 5
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NO_SEATS_TOGETHER');
  });

  it('gives concurrent buyers disjoint blocks', async () => {
    const buyers = await Promise.all([1, 2, 3].map(() => createUser('attendee')));
    const results = await Promise.all(buyers.map((b) => best(b, { quantity: 2 })));
    expect(results.map((r) => r.statusCode)).toEqual([201, 201, 201]);
    const seats = results.flatMap((r) => r.json().items.map((i: Item) => `${i.section}-${i.row}${i.number}`));
    expect(new Set(seats).size).toBe(6);
  });

  it('keeps the event checks: unknown events are 404, ticket limits apply', async () => {
    const buyer = await createUser('attendee');
    const missing = await t.app.inject({
      method: 'POST',
      url: '/api/v1/events/00000000-0000-0000-0000-000000000000/bookings/best',
      headers: buyer.auth,
      payload: { quantity: 2 },
    });
    expect(missing.statusCode).toBe(404);
    expect((await best(buyer, { quantity: 11 })).json().error.code).toBe('TOO_MANY_SEATS');
  });
});
