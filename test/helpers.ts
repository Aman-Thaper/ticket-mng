import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { db } from '../src/db/index.js';
import type { UserRole } from '../src/db/types.js';
import { sentMail } from '../src/lib/mailer.js';
import { redis } from '../src/lib/redis.js';
import { startSession } from '../src/modules/auth/sessions.js';

/** Boots the app once per file and wipes Postgres, Redis and the mail outbox before each test. */
export function useApp() {
  const ctx = {} as { app: FastifyInstance };

  beforeAll(async () => {
    ctx.app = await buildApp({ logger: false });
    await ctx.app.ready();
  });
  beforeEach(async () => {
    await resetState();
  });
  afterAll(async () => {
    await ctx.app.close();
    await Promise.all([db.destroy(), redis.quit()]);
  });

  return ctx;
}

/** Truncate every application table (future-proof: no list to keep in sync) and flush Redis. */
export async function resetState() {
  await sql`
    DO $$
    DECLARE tables text;
    BEGIN
      SELECT string_agg(format('%I', tablename), ', ') INTO tables
      FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE 'kysely_%';
      EXECUTE 'TRUNCATE ' || tables || ' RESTART IDENTITY CASCADE';
    END $$;
  `.execute(db);
  await redis.flushdb();
  sentMail.length = 0;
}

export const inDays = (d: number, hours = 0) =>
  new Date(Date.now() + (d * 24 + hours) * 3600_000).toISOString();

let seq = 0;

export interface TestUser {
  id: string;
  email: string;
  role: UserRole;
  token: string;
  /** Spread into inject() options: `{ headers: user.auth }` */
  auth: { authorization: string };
}

/**
 * A user with a real session and access token, created directly in the database. Only the
 * auth tests go through signup/login; everything else uses this, which is fast and isn't
 * subject to the signup rate limit.
 */
export async function createUser(role: UserRole = 'organizer'): Promise<TestUser> {
  const user = await db
    .insertInto('users')
    .values({ email: `user${++seq}@example.com`, name: `User ${seq}`, role })
    .returningAll()
    .executeTakeFirstOrThrow();
  const { accessToken } = await startSession(db, user, {});
  return {
    id: user.id,
    email: user.email,
    role,
    token: accessToken,
    auth: { authorization: `Bearer ${accessToken}` },
  };
}

export async function createVenue(
  app: FastifyInstance,
  owner: TestUser,
  overrides: Record<string, unknown> = {},
) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/venues',
    headers: owner.auth,
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

export function createEvent(
  app: FastifyInstance,
  organizer: TestUser,
  venueId: string,
  overrides: Record<string, unknown> = {},
) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/events',
    headers: organizer.auth,
    payload: {
      venueId,
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
}

export function publish(app: FastifyInstance, organizer: TestUser, eventId: string) {
  return app.inject({
    method: 'PATCH',
    url: `/api/v1/events/${eventId}`,
    headers: organizer.auth,
    payload: { status: 'published' },
  });
}
