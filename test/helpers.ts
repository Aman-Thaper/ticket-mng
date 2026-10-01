import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { configureDelivery } from '../src/fake-gateway/gateway.js';
import { db } from '../src/db/index.js';
import type { UserRole } from '../src/db/types.js';
import { sentMail } from '../src/lib/mailer.js';
import { closeQueues } from '../src/jobs/queues.js';
import { redis } from '../src/lib/redis.js';
import { startSession } from '../src/modules/auth/sessions.js';

/** Boots the app once per file and wipes Postgres, Redis and the mail outbox before each test. */
export function useApp() {
  const ctx = {} as { app: FastifyInstance };

  beforeAll(async () => {
    ctx.app = await buildApp({ logger: false });
    await ctx.app.ready();
    // The fake payment gateway delivers its signed webhooks straight into this app, and
    // synchronously, so a test knows the webhook has landed when the payment call returns.
    configureDelivery({
      mode: 'sync',
      deliverer: async (body, headers) =>
        (await ctx.app.inject({ method: 'POST', url: '/api/v1/webhooks/fake', payload: body, headers }))
          .statusCode,
    });
  });
  beforeEach(async () => {
    await resetState();
  });
  afterAll(async () => {
    await ctx.app.close();
    await closeQueues();
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
 * subject to the signup rate limit. Users have a confirmed email unless `verified: false`.
 */
export async function createUser(
  role: UserRole = 'organizer',
  { verified = true }: { verified?: boolean } = {},
): Promise<TestUser> {
  const user = await db
    .insertInto('users')
    .values({
      email: `user${++seq}@example.com`,
      name: `User ${seq}`,
      role,
      emailVerifiedAt: verified ? new Date() : null,
    })
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
  return res.json<{ id: string; capacity: number; timezone: string }>();
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

/**
 * Run queued background jobs synchronously: take unpublished outbox rows (and any rows their
 * handlers add) and call the real handlers directly, without Redis or workers. Tests stay
 * deterministic; the BullMQ plumbing has its own end-to-end test (jobs.test.ts).
 *
 * Delayed jobs (run_at in the future) are skipped unless includeDelayed is set.
 */
export async function runQueuedJobs({ includeDelayed = false } = {}): Promise<
  Array<{ name: string; result: unknown }>
> {
  const { handlers } = await import('../src/jobs/handlers/index.js');
  const { logger } = await import('../src/lib/logger.js');
  const ran: Array<{ name: string; result: unknown }> = [];
  for (;;) {
    let q = db.selectFrom('outbox').selectAll().where('publishedAt', 'is', null);
    if (!includeDelayed) q = q.where('runAt', '<=', sql<Date>`now()`);
    const rows = await q.orderBy('id').execute();
    if (!rows.length) return ran;

    await db
      .updateTable('outbox')
      .set({ publishedAt: new Date() })
      .where(
        'id',
        'in',
        rows.map((r) => r.id),
      )
      .execute();
    for (const row of rows) {
      const queueHandlers = handlers[row.queue as keyof typeof handlers] as Record<
        string,
        (job: unknown, log: unknown) => Promise<unknown>
      >;
      const job = { id: `test-${row.id}`, name: row.jobName, data: row.payload, attemptsMade: 0, opts: {} };
      ran.push({
        name: `${row.queue}/${row.jobName}`,
        result: await queueHandlers[row.jobName]!(job, logger),
      });
    }
  }
}

export const TEST_CARDS = {
  ok: '4242424242424242',
  declined: '4000000000000002',
  insufficientFunds: '4000000000009995',
  slow: '4000000000000077',
} as const;

/**
 * Pay for a booking the way a browser would: create the payment, pay at the (fake) provider
 * with a test card, let the signed webhook arrive, then run the queued jobs. Everything
 * between "card charged" and "booking confirmed" runs through the real code paths.
 */
export async function payFor(
  app: FastifyInstance,
  user: TestUser,
  bookingId: string,
  card: string = TEST_CARDS.ok,
) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/bookings/${bookingId}/payment`,
    headers: user.auth,
  });
  if (res.statusCode >= 300) throw new Error(`payment start failed: ${res.body}`);
  const payment = res.json<{ id: string; providerPaymentId: string; clientSecret: string }>();
  const gateway = await app.inject({
    method: 'POST',
    url: `/fake-gateway/v1/payment_intents/${payment.providerPaymentId}/confirm`,
    payload: { clientSecret: payment.clientSecret, cardNumber: card },
  });
  const jobs = await runQueuedJobs();
  return { payment, gateway, jobs };
}
