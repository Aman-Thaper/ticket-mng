# Bookings: the hardest part

Open `src/modules/bookings/service.ts`. The big comment at the top is worth reading slowly. This chapter explains it from zero.

## The problem: a race condition

Holding a seat sounds simple:

```text
1. read the seat           → status = 'available'
2. if available, write     → status = 'held', booking_id = my booking
```

Now imagine two buyers, A and B, clicking the same seat at the same millisecond. Their steps can interleave:

```text
A: read seat  → available
B: read seat  → available          (A hasn't written yet!)
A: write      → held by A          → A gets "201 Created"
B: write      → held by B          → B gets "201 Created"   ← both think they own it!
```

That's a **race condition**, and it's exactly how double-booking happens. The project proves it: `npm run race` sends 200 simultaneous requests for one seat. With the deliberately broken `naive` strategy, **11 people** got the seat. With the correct strategies, exactly **1**.

## Four strategies (all in the code, for comparison)

| Strategy | Idea | Result in the race test |
|---|---|---|
| `naive` | read, check, write, no locking | **11 owners** (broken on purpose, refused in production) |
| `optimistic` | no locks; write only if the version is still what I read | 1 owner |
| `serializable` | strictest isolation level; Postgres aborts conflicting transactions | 1 owner |
| `pessimistic` (default) | lock the rows while reading: `SELECT ... FOR UPDATE SKIP LOCKED` | 1 owner |
| `pessimistic` + claim gate | first a fast Redis check, then the above | 1 owner, and only 30 of 200 reached Postgres |

**Optimistic locking** uses the `version` column. The write says "update this seat only if its version is still 7". If someone changed it in between, the version is 8, zero rows match, and we report a conflict:

```postgresql
UPDATE event_seats es
SET status = 'held', booking_id = $1, version = es.version + 1
FROM unnest($2::bigint[], $3::int[]) AS seen(id, version)
WHERE es.id = seen.id AND es.version = seen.version
RETURNING es.id, es.event_id, es.status, es.version
```

(`$1` is the new booking's id, `$2` the seat ids and `$3` the versions that were read earlier; in the code they are passed with Kysely's `sql` tag.)

**Pessimistic locking** takes a row lock while reading. `FOR UPDATE` means "these rows are mine until I commit". Normally, other transactions would *wait* for the lock. `SKIP LOCKED` tells them instead to *skip* locked rows. So a loser sees fewer seats than it asked for and fails instantly with 409, instead of waiting in line while holding a database connection:

```ts
async pessimistic(req, event, opts) {
  return withTransaction(async (trx) => {
    const rows = await seatQuery(trx, req.seatIds)
      .where('es.eventId', '=', req.eventId)
      .forUpdate('es')           // lock these seat rows
      .skipLocked()              // ...but skip ones someone else has locked right now
      .execute();
    if (rows.length < req.seatIds.length) {
      await assertSeatsExist(trx, req.eventId, req.seatIds, rows);   // 422 if ids are bogus
      throw conflict('SEATS_UNAVAILABLE', 'Some seats are being booked by someone else right now', {...});
    }
    assertAcquirable(rows);      // 409 if a seat is already held or booked
    return createHold(trx, req, event, rows, opts, 'plain');
  });
},
```

## The claim gate (`claims.ts`): a Redis shield in front

Even with `SKIP LOCKED`, 200 requests all open a database transaction. During a big sale, database connections are the scarcest resource. So before touching Postgres, each request tries to **claim** its seats in Redis with `SET key value NX PX 5000` ("set only if it doesn't exist, expire after 5 seconds"). This runs as a small **Lua script** inside Redis, so claiming several seats is all-or-nothing and atomic:

```lua
for i, key in ipairs(KEYS) do
  if not redis.call('SET', key, ARGV[1], 'NX', 'PX', ARGV[2]) then
    -- someone else holds this seat: undo the claims I made so far
    for j = 1, i - 1 do
      if redis.call('GET', KEYS[j]) == ARGV[1] then redis.call('DEL', KEYS[j]) end
    end
    return i          -- which seat conflicted
  end
end
return 0              -- all claimed
```

199 of the 200 get turned away in about 0.1 ms without touching the database.

<div class="warn"><b>The claim gate is a load shield, NOT the lock.</b> A Redis key with a timeout can expire while its owner is still working, or be lost if Redis restarts. So the database transaction still decides who wins. If Redis is down, the gate is simply skipped (<code>catch → return { ok: true }</code>): more database load, never a wrong answer. Each claim stores a random token and is only deleted by the same token, so a slow request can never release someone else's claim.</div>

## `holdSeats`: the whole flow

```ts
export async function holdSeats(req: HoldRequest, opts: BookingOptions) {
  const seatIds = [...new Set(req.seatIds)].sort((a, b) => a - b);   // dedupe + sort
  const request = { ...req, seatIds };
  const event = await loadSaleableEvent(req.eventId, seatIds.length);  // published? on sale?
  await checkUserLimits(request, event);                               // existing hold? ticket limit?

  const claim = opts.claimGate ? await claimSeats(req.eventId, seatIds) : null;
  if (claim && !claim.ok) {
    holdAttempts.inc({ strategy: opts.strategy, outcome: 'gate_rejected' });
    throw conflict('SEATS_UNAVAILABLE', '...', { seatIds: [claim.conflictingSeatId] });
  }

  try {
    const result = await strategies[opts.strategy](request, event, opts);
    holdAttempts.inc({ strategy: opts.strategy, outcome: 'success' });
    return result;
  } catch (err) {
    // ... count the failure; turn the "one pending hold per user" index violation into HOLD_EXISTS
    throw err;
  } finally {
    await claim?.release();          // always release the Redis claims
  }
}
```

The order is deliberate: **cheap checks first** (no locks: is the event on sale? does this user already have a hold?), then the Redis gate, and only then the expensive locked transaction.

`createHold` (called inside the transaction) does the actual writes:

1. `INSERT INTO bookings` with status `pending` and `expires_at = now() + 10 minutes` (using the **database's** clock, not the server's);
2. `enqueue(...)` an `expire-booking` job for that time (through the outbox, in the same transaction);
3. `UPDATE event_seats SET status='held', booking_id=..., version=version+1` and pass the changed rows to `changed(...)`, which publishes them to live seat maps **after commit**;
4. `INSERT INTO booking_items` (which seats, at which price);
5. if any of the seats were taken over from a *lapsed* hold, mark that old booking `expired`.

## Lazy expiry: holds expire without waiting for a job

A hold lasts 10 minutes. The obvious design: a timer job flips it to expired. But what if the worker is down or late? The seat would stay blocked. This project does something smarter. A seat counts as **free** if it's available **or** held by a booking that is no longer an active hold:

```ts
export const acquirableSql = sql<boolean>`(es.status = 'available' OR
  (es.status = 'held' AND (b.status <> 'pending' OR b.expires_at <= now())))`;
```

This exact expression is used everywhere availability matters: the seat map, the availability count, placing a hold, confirming a payment. So the moment `expires_at` passes (by the database clock, which all servers share), the seat is free. The `expire-booking` job and a 30-second sweep only *tidy up* the rows and notify live viewers. **Correctness never waits for a background job.**

## Deadlocks and the global lock order

A **deadlock**: transaction 1 locks seat A and wants booking X; transaction 2 locks booking X and wants seat A. Each waits for the other forever (Postgres detects it and kills one).

The fix is simple and powerful: **always lock things in the same order.** In this codebase, every operation that touches bookings (hold, pay, cancel, expire, refund, cancel event) locks **seat rows first (in ascending id order), then the booking, then the payment.** With one global order, a cycle is impossible. That's what `lockBooking` does:

```ts
export async function lockBooking(trx: Transaction<DB>, bookingId: string) {
  const items = await trx.selectFrom('bookingItems').select('eventSeatId')
    .where('bookingId', '=', bookingId).orderBy('eventSeatId').execute();
  const seatIds = items.map((i) => i.eventSeatId);
  const seats = seatIds.length ? await seatQuery(trx, seatIds).forUpdate('es').execute() : [];  // 1. seats
  const booking = await trx.selectFrom('bookings').selectAll()
    .select(sql<boolean>`expires_at <= now()`.as('lapsed'))
    .where('id', '=', bookingId)
    .forUpdate()                                                                                // 2. booking
    .executeTakeFirst();
  return { seats, booking, seatIds };
}
```

## The life of a booking

<div class="diagram">
<svg viewBox="0 0 760 250" xmlns="http://www.w3.org/2000/svg" font-family="DejaVu Sans, sans-serif" font-size="12">
  <defs><marker id="d" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#555"/></marker></defs>
  <g stroke-width="1.5">
  <rect x="30" y="100" width="110" height="40" rx="20" fill="#fff4e0" stroke="#d18a1f"/><text x="85" y="125" text-anchor="middle" font-weight="bold">pending</text>
  <rect x="330" y="100" width="120" height="40" rx="20" fill="#e6f5ea" stroke="#2e8b57"/><text x="390" y="125" text-anchor="middle" font-weight="bold">confirmed</text>
  <rect x="610" y="100" width="120" height="40" rx="20" fill="#eee" stroke="#777"/><text x="670" y="125" text-anchor="middle" font-weight="bold">refunded</text>
  <rect x="200" y="20" width="110" height="40" rx="20" fill="#fde8e8" stroke="#c0392b"/><text x="255" y="45" text-anchor="middle" font-weight="bold">expired</text>
  <rect x="200" y="190" width="110" height="40" rx="20" fill="#fde8e8" stroke="#c0392b"/><text x="255" y="215" text-anchor="middle" font-weight="bold">cancelled</text>
  </g>
  <g stroke="#555" fill="none" marker-end="url(#d)">
  <line x1="140" y1="120" x2="328" y2="120"/><line x1="110" y1="100" x2="205" y2="58"/><line x1="110" y1="140" x2="205" y2="192"/>
  <line x1="300" y1="58" x2="360" y2="100"/><line x1="300" y1="192" x2="360" y2="140"/><line x1="450" y1="120" x2="608" y2="120"/>
  <path d="M420,140 Q400,215 312,212"/>
  </g>
  <text x="235" y="113" text-anchor="middle" font-size="11">payment succeeded</text>
  <text x="120" y="70" font-size="11">hold lapsed</text>
  <text x="60" y="180" font-size="11">buyer cancels /</text><text x="60" y="194" font-size="11">event cancelled</text>
  <text x="335" y="70" font-size="10.5">late payment,</text><text x="335" y="83" font-size="10.5">seats still free</text>
  <text x="530" y="113" text-anchor="middle" font-size="11">refund completed</text>
  <text x="430" y="200" font-size="10.5">free booking of a cancelled event</text>
</svg>
<div class="caption">Booking states. Holds become confirmed when paid; lapsed or cancelled holds can still be confirmed by a late payment if the seats are free.</div>
</div>

The functions that move between states, all in `bookings/service.ts`:

- `expireBooking(id)`: pending + lapsed → `expired`, release seats. Safe to call many times ("idempotent").
- `cancelPendingBooking(id)`: the buyer walks away → `cancelled`, release seats.
- `confirmBookingInTx(trx, id, { lateAllowed })`: pending → `confirmed`, seats `held` → `booked`, **issue tickets**, and queue the confirmation email, all in the caller's transaction. With `lateAllowed` (used by payments), if the hold lapsed but the seats are still free, it takes them back instead of refunding: money has already moved, so honour the purchase if possible. It returns an *outcome* (`confirmed`, `seats_lost`, `hold_expired`, `event_unavailable`, ...) so the payment code can decide to refund.
- `endConfirmedBookingInTx(trx, id, 'refunded' | 'cancelled')`: void tickets and release seats.

<div class="tip"><b>Big lessons from this chapter.</b> (1) Any "check then act" on shared data is a race unless something locks or verifies it. (2) Let the database decide; use caches only to reduce load. (3) Lock in one global order. (4) Don't depend on timers for correctness; compute state from timestamps. (5) Prove it with a test that fires many concurrent requests.</div>

# Background jobs and the outbox

## The "dual write" problem

When a booking is confirmed, two things must happen: the database saves the booking, and an email job is added to the Redis queue. Those are **two different systems**. Whatever order you pick, a crash in the middle is a bug:

- save to DB, *crash*, never enqueue → the customer paid but never gets tickets;
- enqueue first, then the DB transaction *rolls back* → an email for a booking that doesn't exist.

## The solution: the transactional outbox (`src/jobs/outbox.ts`)

Code **never** talks to the queue directly. Instead it inserts a row into an `outbox` **table**, in the **same transaction** as the business change:

```ts
export async function enqueue(conn, queue, name, data, opts = {}): Promise<void> {
  await conn
    .insertInto('outbox')
    .values({
      queue,
      jobName: name,
      payload: JSON.stringify(data),
      jobId: opts.jobId ?? null,               // dedupe key
      runAt: opts.runAt ?? sql<Date>`now()`,   // for delayed jobs
      requestId: currentRequestId() ?? null,   // links the job's logs to the request
    })
    .execute();
}
```

Both commit or neither does. Then a **relay** in the worker process moves committed rows into BullMQ:

<div class="diagram">
<svg viewBox="0 0 760 170" xmlns="http://www.w3.org/2000/svg" font-family="DejaVu Sans, sans-serif" font-size="12">
  <defs><marker id="e" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#555"/></marker></defs>
  <rect x="10" y="50" width="160" height="60" rx="8" fill="#e6f5ea" stroke="#2e8b57"/><text x="90" y="75" text-anchor="middle" font-weight="bold">API transaction</text><text x="90" y="92" text-anchor="middle" font-size="10.5">change + INSERT outbox</text>
  <rect x="210" y="50" width="110" height="60" rx="8" fill="#fde8e8" stroke="#c0392b"/><text x="265" y="85" text-anchor="middle" font-weight="bold">outbox table</text>
  <rect x="360" y="50" width="110" height="60" rx="8" fill="#e6f5ea" stroke="#2e8b57"/><text x="415" y="78" text-anchor="middle" font-weight="bold">relay</text><text x="415" y="94" text-anchor="middle" font-size="10.5">(in worker)</text>
  <rect x="510" y="50" width="110" height="60" rx="8" fill="#f3e8fd" stroke="#8e44ad"/><text x="565" y="78" text-anchor="middle" font-weight="bold">BullMQ</text><text x="565" y="94" text-anchor="middle" font-size="10.5">(Redis)</text>
  <rect x="660" y="50" width="90" height="60" rx="8" fill="#e6f5ea" stroke="#2e8b57"/><text x="705" y="85" text-anchor="middle" font-weight="bold">handler</text>
  <g stroke="#555" marker-end="url(#e)"><line x1="170" y1="80" x2="208" y2="80"/><line x1="320" y1="80" x2="358" y2="80"/><line x1="470" y1="80" x2="508" y2="80"/><line x1="620" y1="80" x2="658" y2="80"/></g>
  <text x="190" y="72" text-anchor="middle" font-size="10">COMMIT</text><text x="340" y="45" text-anchor="middle" font-size="10">NOTIFY / poll</text><text x="490" y="45" text-anchor="middle" font-size="10">fixed jobId</text>
  <path d="M705,110 Q705,150 565,150 Q540,150 560,112" fill="none" stroke="#999" stroke-dasharray="4 3" marker-end="url(#e)"/><text x="640" y="163" text-anchor="middle" font-size="10">failed? retry with backoff, then dead-letter queue</text>
</svg>
</div>

```ts
export async function publishOutboxBatch(): Promise<number> {
  return withTransaction(async (trx) => {
    const rows = await trx.selectFrom('outbox').selectAll()
      .where('publishedAt', 'is', null)
      .orderBy('id').limit(BATCH)
      .forUpdate().skipLocked()          // several relays can run without taking the same rows
      .execute();
    if (!rows.length) return 0;
    // group by queue and add to BullMQ with a FIXED job id
    for (const [queue, items] of byQueue) {
      await getQueue(queue).addBulk(items.map((r) => ({
        name: r.jobName,
        data: { ...r.payload, _meta: { requestId: r.requestId, outboxId: r.id } },
        opts: { jobId: r.jobId ?? `outbox-${r.id}`, delay: Math.max(0, r.runAt.getTime() - now) },
      })));
    }
    await trx.updateTable('outbox').set({ publishedAt: new Date() }).where('id', 'in', rows.map((r) => r.id)).execute();
    return rows.length;
  }, { retries: 0 });
}
```

Why every piece is there:

- `FOR UPDATE SKIP LOCKED` (again!): if you run several workers, each takes different rows.
- **Fixed job id**: if the relay crashes *after* adding to Redis but *before* marking rows published, it will publish them again. BullMQ ignores a job whose id already exists, so the duplicate is harmless.
- **How the relay wakes up**: a database trigger runs `pg_notify('outbox')` when a row is inserted; the relay `LISTEN`s and reacts within milliseconds. It also polls every 2 seconds in case a notification is missed. (Migration 0006 is a lesson from load testing: notifying on *every* insert slowed commits, so now only jobs due immediately notify; delayed ones are found by polling.)

This gives **at-least-once delivery**: a job may run twice, but never zero times. So every handler must be **idempotent** (safe to run twice).

## Queues and job types (`src/jobs/queues.ts`)

All job types are declared in one TypeScript interface, so a typo in a job name or a wrong payload is a compile error:

```ts
export interface Jobs {
  email: {
    'password-reset': { email: string };
    'booking-confirmed': { bookingId: string };
    'event-reminder': { bookingId: string };
    'refund-processed': { refundId: string };
  };
  payments: {
    'process-webhook': { provider: string; eventId: string };
    refund: { refundId: string };
    'refund-event': { eventId: string };
  };
  bookings: { 'expire-booking': { bookingId: string }; 'sweep-expired-holds': Record<string, never> };
  media: { 'process-poster': { eventId: string; key: string } };
  maintenance: { 'send-event-reminders': Record<string, never>; cleanup: Record<string, never> };
}
```

Payloads carry **ids only**, never copies of data. By the time a job runs (maybe 10 minutes later), the data may have changed, so the handler re-reads the current state.

Retry policy: 5 attempts with exponential backoff and jitter (about 2 s, 4 s, 8 s, 16 s, each ±50%), so a burst of jobs that failed together (the email server blipped) doesn't retry in lockstep and knock it over again.

`src/jobs/handlers/index.ts` maps every job name to its handler function, and its type makes TypeScript complain if you declare a job but forget its handler.

## The runner and the dead-letter queue (`runner.ts`)

`createWorker(queue, handlers, concurrency)` builds a BullMQ worker that looks up the handler by job name, gives it a logger tagged with the queue, job id, attempt number and **the original request id**, measures duration for metrics, and, when a job has failed for the last time, copies it into a **dead-letter queue**:

```ts
worker.on('failed', (job, err) => {
  if (!job || !isFinalFailure(job, err)) return;
  sendToDeadLetter(job, err).catch(...);
});
```

Nothing consumes the dead-letter queue. It waits for a human: `GET /api/v1/admin/dead-letters` lists failed jobs with their error, and admins can retry or discard them. Failures don't silently disappear.

## Idempotent handlers: sending an email once (`handlers/email.ts`)

```ts
export async function sendOnce(kind, refId, userId, send): Promise<'sent' | 'already_sent'> {
  return db.transaction().execute(async (trx) => {
    await trx.insertInto('notifications').values({ kind, refId, userId })
      .onConflict((oc) => oc.columns(['kind', 'refId']).doNothing())
      .execute();
    const row = await trx.selectFrom('notifications').select('status')
      .where('kind', '=', kind).where('refId', '=', refId)
      .forUpdate()                       // a duplicate job waits here
      .executeTakeFirstOrThrow();
    if (row.status === 'sent') return 'already_sent';
    await send();                         // talk to the SMTP server
    await trx.updateTable('notifications').set({ status: 'sent', sentAt: sql`now()` })
      .where('kind', '=', kind).where('refId', '=', refId).execute();
    return 'sent';
  });
}
```

Each email has a natural key (for example `booking-confirmed` + booking id). The row is locked during the send, so a concurrent duplicate waits and then sees `sent`. The only remaining gap is a crash *after* the email server accepted the message but *before* the commit; that's the unavoidable edge of at-least-once delivery, and it's documented honestly.

(This is the one intentional exception to "no network calls inside a transaction": here the lock is exactly what guarantees once-only sending.)

## Scheduled jobs (`schedules.ts`)

```ts
await getQueue('bookings').upsertJobScheduler('sweep-expired-holds', { every: 30_000 }, {...});
await getQueue('maintenance').upsertJobScheduler('send-event-reminders', { every: 15 * 60_000 }, {...});
await getQueue('maintenance').upsertJobScheduler('cleanup', { pattern: '0 3 * * *', tz: 'UTC' }, {...});
```

`upsert` means "create or update": every worker can call it at startup and Redis still holds exactly one schedule, so jobs don't run N times with N workers. `'0 3 * * *'` is cron syntax: minute 0, hour 3, every day.

The handlers:

- `sweep-expired-holds` (every 30 s): finds pending bookings past their expiry and seats still "held" by non-pending bookings, and releases them. A safety net for lost expiry jobs.
- `send-event-reminders` (every 15 min): emails attendees before their event.
- `cleanup` (daily): deletes old outbox rows, expired tokens, stale idempotency keys and similar.
