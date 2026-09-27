import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { db } from '../src/db/index.js';

/** Boots the app once per file and wipes every table before each test. */
export function useApp() {
  const ctx = {} as { app: FastifyInstance };

  beforeAll(async () => {
    ctx.app = await buildApp({ logger: false });
    await ctx.app.ready();
  });
  beforeEach(async () => {
    await sql`TRUNCATE users, venues, venue_sections, venue_seats, events, event_seats RESTART IDENTITY CASCADE`.execute(
      db,
    );
  });
  afterAll(async () => {
    await ctx.app.close();
    await db.destroy();
  });

  return ctx;
}

const inDays = (d: number, hours = 0) => new Date(Date.now() + (d * 24 + hours) * 3600_000).toISOString();
export { inDays };

let seq = 0;

export async function createUser(app: FastifyInstance, role: 'attendee' | 'organizer' = 'organizer') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/users',
    payload: { email: `user${++seq}@example.com`, name: `User ${seq}`, role },
  });
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json<{ id: string }>();
}

export async function createVenue(app: FastifyInstance, overrides: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/venues',
    payload: {
      name: 'Test Arena',
      address: '1 Main St',
      city: 'Berlin',
      country: 'DE',
      sections: [
        { name: 'Floor', rows: 2, seatsPerRow: 5 },
        { name: 'Balcony', rows: 1, seatsPerRow: 4 },
      ],
      ...overrides,
    },
  });
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json<{ id: string; capacity: number }>();
}

export async function createEvent(
  app: FastifyInstance,
  ids: { organizerId: string; venueId: string },
  overrides: Record<string, unknown> = {},
) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/events',
    payload: {
      ...ids,
      title: 'Test Concert',
      category: 'concert',
      startsAt: inDays(7),
      endsAt: inDays(7, 3),
      pricing: [
        { section: 'Floor', priceCents: 8000 },
        { section: 'Balcony', priceCents: 4500 },
      ],
      ...overrides,
    },
  });
  return res;
}
