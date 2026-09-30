/**
 * The double-booking experiment: 200 different users try to hold THE SAME seat at the same
 * instant, over real HTTP, once per hold strategy.
 *
 *   npm run race                       # all strategies, 200 requests each
 *   npm run race -- --requests 500     # more pressure
 *
 * A correct strategy yields exactly one 201 and 199 × 409. More than one 201 means the
 * seat was sold several times: a race condition.
 *
 * Runs against the dev database (DATABASE_URL). It creates its own venue, event and users,
 * and removes them afterwards.
 */
import { parseArgs } from 'node:util';
import type { AddressInfo } from 'node:net';
import { sql } from 'kysely';
import { buildApp } from '../src/app.js';
import { db } from '../src/db/index.js';
import { holdAttempts } from '../src/lib/metrics.js';
import { redis } from '../src/lib/redis.js';
import { startSession } from '../src/modules/auth/sessions.js';
import type { HoldStrategy } from '../src/modules/bookings/service.js';

const { values } = parseArgs({ options: { requests: { type: 'string', default: '200' } } });
const REQUESTS = Number(values.requests);

const RUNS: Array<{ strategy: HoldStrategy; claimGate: boolean }> = [
  { strategy: 'naive', claimGate: false },
  { strategy: 'optimistic', claimGate: false },
  { strategy: 'serializable', claimGate: false },
  { strategy: 'pessimistic', claimGate: false },
  { strategy: 'pessimistic', claimGate: true },
];

const tag = `race-${Date.now()}`;

async function setup() {
  const organizer = await db
    .insertInto('users')
    .values({ email: `${tag}-organizer@example.com`, name: 'Race Organizer', role: 'organizer' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const venue = await db
    .insertInto('venues')
    .values({ name: `${tag} Hall`, address: '1 Race St', city: 'Testville', country: 'US', capacity: 1 })
    .returning('id')
    .executeTakeFirstOrThrow();
  const section = await db
    .insertInto('venueSections')
    .values({ venueId: venue.id, name: 'Floor', sortOrder: 0 })
    .returning('id')
    .executeTakeFirstOrThrow();
  const venueSeat = await db
    .insertInto('venueSeats')
    .values({ sectionId: section.id, rowLabel: 'A', seatNumber: 1, x: 0, y: 0 })
    .returning('id')
    .executeTakeFirstOrThrow();
  const event = await db
    .insertInto('events')
    .values({
      organizerId: organizer.id,
      venueId: venue.id,
      title: 'The Race',
      category: 'concert',
      status: 'published',
      startsAt: new Date(Date.now() + 7 * 86_400_000),
      endsAt: new Date(Date.now() + 7 * 86_400_000 + 7_200_000),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const seat = await db
    .insertInto('eventSeats')
    .values({ eventId: event.id, venueSeatId: venueSeat.id, priceCents: 5000 })
    .returning('id')
    .executeTakeFirstOrThrow();

  const buyers = await db
    .insertInto('users')
    .values(
      Array.from({ length: REQUESTS }, (_, i) => ({
        email: `${tag}-${i}@example.com`,
        name: `Buyer ${i}`,
        role: 'attendee' as const,
        emailVerifiedAt: new Date(), // booking requires a confirmed address
      })),
    )
    .returning(['id', 'role'])
    .execute();
  const tokens = await Promise.all(buyers.map(async (b) => (await startSession(db, b, {})).accessToken));

  return {
    organizerId: organizer.id,
    venueId: venue.id,
    eventId: event.id,
    seatId: seat.id,
    buyerIds: buyers.map((b) => b.id),
    tokens,
  };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

async function resetSeat(f: Fixture) {
  await db
    .updateTable('eventSeats')
    .set({ status: 'available', bookingId: null, version: 0 })
    .where('id', '=', f.seatId)
    .execute();
  await db.deleteFrom('bookings').where('eventId', '=', f.eventId).execute();
  // Fresh rate-limit buckets, so repeated runs measure the booking path, not the throttle.
  const keys = await redis.keys('rl:holds:user:*');
  if (keys.length) await redis.del(...keys);
}

async function attemptsByOutcome(strategy: HoldStrategy) {
  const metric = await holdAttempts.get();
  const counts: Record<string, number> = {};
  for (const v of metric.values)
    if (v.labels.strategy === strategy) counts[String(v.labels.outcome)] = v.value;
  return counts;
}

async function run(f: Fixture, strategy: HoldStrategy, claimGate: boolean) {
  await resetSeat(f);
  holdAttempts.reset();
  const app = await buildApp({ logger: false }, { booking: { strategy, claimGate } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/v1/events/${f.eventId}/bookings`;

  // Fire every request at once: build all the promises before awaiting any of them.
  const started = performance.now();
  const results = await Promise.all(
    f.tokens.map(async (token) => {
      const t0 = performance.now();
      const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ seatIds: [f.seatId] }),
      });
      await res.arrayBuffer();
      return { status: res.status, ms: performance.now() - t0 };
    }),
  );
  const wallMs = performance.now() - started;
  await app.close();

  const status = (code: number) => results.filter((r) => r.status === code).length;
  const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (p: number) =>
    latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))]!;

  // Ground truth from the database: how many active bookings think they own the seat?
  const { owners } = await db
    .selectFrom('bookingItems as bi')
    .innerJoin('bookings as b', 'b.id', 'bi.bookingId')
    .select(sql<number>`count(DISTINCT b.id)`.as('owners'))
    .where('bi.eventSeatId', '=', f.seatId)
    .where('b.status', '=', 'pending')
    .executeTakeFirstOrThrow();

  const attempts = await attemptsByOutcome(strategy);
  return {
    strategy: strategy + (claimGate ? ' + gate' : ''),
    '201': status(201),
    '409': status(409),
    other: results.length - status(201) - status(409),
    'owners in DB': owners,
    'reached DB': (attempts.success ?? 0) + (attempts.db_conflict ?? 0) + (attempts.error ?? 0),
    'p50 ms': Math.round(pct(50)),
    'p99 ms': Math.round(pct(99)),
    'total ms': Math.round(wallMs),
    verdict: owners === 1 && status(201) === 1 ? 'correct' : `DOUBLE BOOKED ×${owners}`,
  };
}

async function cleanup(f: Fixture) {
  await resetSeat(f);
  await db.deleteFrom('events').where('id', '=', f.eventId).execute();
  await db.deleteFrom('venues').where('id', '=', f.venueId).execute();
  await db.deleteFrom('users').where('email', 'like', `${tag}-%`).execute();
}

const fixture = await setup();
try {
  console.log(`\n${REQUESTS} users hold the same seat at the same instant, once per strategy:\n`);
  const rows = [];
  for (const { strategy, claimGate } of RUNS) rows.push(await run(fixture, strategy, claimGate));
  console.table(rows);
  console.log(
    '\n"reached DB" counts attempts that ran a database transaction. The gate answers the rest from Redis.\n' +
      'naive is expected to double-book; that is the bug the other strategies fix.\n',
  );
} finally {
  await cleanup(fixture);
  await Promise.all([db.destroy(), redis.quit()]);
}
