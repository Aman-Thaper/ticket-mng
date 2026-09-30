# Trace one purchase from start to finish

Now let's connect everything. Here is what happens, file by file, when a buyer buys two seats. Try to picture each step; if one is unclear, go back to its chapter.

**1. Page load.** The browser loads `index.html` and `app.js` (served by `@fastify/static`, with a Content-Security-Policy). `app.js` calls `GET /api/v1/events` → `events/routes.ts` → `readThrough` (Redis cache keyed by the event-lists generation) → on a miss, `listEvents` (keyset pagination) → JSON.

**2. Log in.** `POST /auth/login` → rate limits (`enforce`) → look up the user → `verifyPassword` (Argon2id) → `startSession` inserts `sessions` + `refresh_tokens` → the response carries the **access token** (JSON) and sets the **refresh cookie** (httpOnly).

**3. Open the seat map.** The page opens a WebSocket to `/events/:id/live` → `hub.join` subscribes this server to `seats:<eventId>` in Redis → `hello` → the page loads `GET /events/:id/seats` → `seatMapCache` (MicroCache, 1 s, single-flight) → `buildSeatMap` (uses `acquirableSql`, so lapsed holds show as free) → drawn as SVG.

**4. Hold two seats.** `POST /events/:id/bookings` with an `Idempotency-Key`:

- Nginx → a replica (`least_conn`), request id assigned;
- `onRequest` hooks: metrics, request context, per-IP token bucket;
- `requireAuth`: verify the JWT, check the Redis denylist;
- Zod validates `seatIds`;
- per-user hold limit; `withIdempotency` claims the key;
- `holdSeats`: `loadSaleableEvent` → `checkUserLimits` → **claim gate** (Redis Lua `SET NX`) → **transaction**: `SELECT ... FOR UPDATE SKIP LOCKED` (seats, ascending id) → `INSERT bookings` (pending, `expires_at = now() + 10 min`) → `enqueue` expire-booking (**outbox row**) → `UPDATE event_seats` to held (version + 1) → `INSERT booking_items` → **COMMIT**;
- after commit: `PUBLISH seats:<eventId>` (live update) and cache generation bumps;
- claims released; the idempotency row stores the response; `201 Created`.

**5. Everyone else sees it.** Every API replica with viewers of this event receives the Redis message → the hub batches for 100 ms → each viewer's browser gets `[[seatId, "held", version], ...]` → `applyUpdates` paints those seats as held (only if the version is newer).

**6. Meanwhile, in the worker.** The database trigger NOTIFYs → the `OutboxRelay` wakes (or polls) → `publishOutboxBatch` moves the expire-booking row into BullMQ as a **delayed** job with a fixed id, due in 10 minutes.

**7. Pay.** `POST /bookings/:id/payment` → `startPayment` (lock booking, reuse or insert a `payments` row) → outside the transaction, `provider.createPayment(..., 'payment-<id>')` → client secret → the browser pays at the provider.

**8. Webhook.** The provider POSTs a signed webhook to `/api/v1/webhooks/fake` → raw-body parser → `verifyWebhookSignature` (HMAC, timestamp window, constant-time compare) → `INSERT webhook_events ON CONFLICT DO NOTHING` + outbox row for `process-webhook` → `200` in milliseconds.

**9. Confirm.** Worker: `processWebhook` → `reconcilePayment` → `provider.retrievePayment` says `succeeded` → `recordSuccess` → one transaction: `confirmBookingInTx` (lock seats → booking; seats `booked`; booking `confirmed`; `issueTickets`; outbox row for the `booking-confirmed` email) → lock payment → payment `succeeded` → COMMIT → after commit, live update: seats turn "sold" on every viewer's map.

**10. Email.** Relay → `email` queue → `bookingConfirmed` handler → `sendOnce('booking-confirmed', bookingId, ...)` → loads the booking, signs each ticket with Ed25519, renders QR PNGs, sends via SMTP (Mailpit locally) → `notifications` row marked `sent`.

**11. The page.** `waitForOutcome` polls `GET /bookings/:id` until `confirmed` → `GET /bookings/:id/tickets` → QR codes shown.

**12. Ten minutes later.** The delayed `expire-booking` job runs → `expireBooking` locks the booking, sees it is `confirmed` → does nothing. (Idempotent handlers make "late" or "unnecessary" jobs harmless.)

**13. At the door.** Staff scan the QR → `POST /check-in` → `verifyTicket` (signature) → conditional `UPDATE tickets SET checked_in_at = now() WHERE checked_in_at IS NULL` → admitted exactly once.

Throughout, one **request id** ties together the Nginx log, the API log lines, and the worker's logs for every job this purchase caused, and metrics (`booking_hold_attempts_total`, `job_duration_seconds`, `http_request_duration_seconds`) record it all.

<div class="tip"><b>Exercise.</b> Run the stack (<code>docker compose up -d --build</code>, then seed as in the README), buy a ticket at <code>http://localhost:8080</code>, copy the <code>x-request-id</code> from the browser's network tab, and run <code>docker compose logs api worker nginx | grep &lt;id&gt;</code>. Then look at the rows in <code>bookings</code>, <code>outbox</code>, <code>payments</code>, <code>webhook_events</code>, <code>tickets</code> and <code>notifications</code>. If you can explain each step and why it is safe to repeat, you understand the system. (<code>docs/STUDY-GUIDE.md</code> has this "capstone" and many more experiments.)</div>

# How to build your own project

You've now seen a big project from the inside. Here's how to use that to build your own.

## The skeleton every backend shares

Almost every backend you build will have these parts. You've seen each one in this project:

| Part | In ticket-mng | What to do in yours |
|---|---|---|
| Config, validated at startup | `src/config.ts` | Zod (or similar) schema over env vars; crash on bad config |
| Entry point + graceful shutdown | `src/server.ts` | listen; handle SIGTERM; close resources |
| App factory | `src/app.ts` (`buildApp`) | a function that builds the app (tests use it) |
| Feature modules | `src/modules/<feature>/` | `routes.ts` (HTTP) + `service.ts` (rules) |
| Database access | `src/db/` | a pool, migrations, a transaction helper |
| One error format + central handler | `src/lib/errors.ts` | `AppError` + one `setErrorHandler` |
| Validation at the edge | Zod schemas on each route | validate every input; shape every output |
| Auth | `src/modules/auth/` | hashed passwords; tokens or sessions; a guard |
| Logging | `src/lib/logger.ts` | structured JSON logs with a request id |
| Tests | `test/` | HTTP-level tests with a real database |

## A step-by-step recipe for a new project

Build in **phases**, like this project did (its README roadmap has 7). Each phase should end with something that works.

1. **Write down the domain.** Nouns become tables (user, venue, event, seat, booking). Verbs become endpoints or state transitions (hold, pay, cancel). Draw the states of anything with a status.
2. **Design the tables first** and put rules in the database: `NOT NULL`, `CHECK`, foreign keys, unique indexes. Write them as migrations.
3. **Skeleton**: config, `buildApp`, one health route, error handler, logger. Get `GET /health` working.
4. **First resource end to end**: one `routes.ts` with create/list/get, Zod schemas, a DTO, and a test using `app.inject`.
5. **Auth**: signup, login, a guard, roles, ownership checks.
6. **The core business action** (for you it might be "place order", "book appointment", "enrol in course"). Ask: *what if two people do this at the same moment?* Use a transaction and either a row lock, a conditional update, or a unique constraint. Write a concurrency test with `Promise.all`.
7. **Slow or later work** goes to a queue. Start simple; add the outbox pattern once jobs must match database changes.
8. **Only then** add caching, rate limits, WebSockets, Docker and CI, when you have the problem they solve.

## Questions to ask about every feature

These are the questions this codebase keeps asking. Asking them is what separates a toy project from a real one:

- **What if this runs twice?** (retries, double-clicks, duplicate webhooks) → make it idempotent: unique keys, `ON CONFLICT DO NOTHING`, conditional updates, idempotency keys.
- **What if two of these run at the same time?** → transactions, locks in a consistent order, constraints.
- **What if it crashes halfway?** → transactions; the outbox; state derived from timestamps instead of timers.
- **What if the other service is down or slow?** → timeouts, retries with backoff and jitter, fail open or fail closed deliberately.
- **What can a malicious user send?** → validate everything; check ownership; rate limit; don't leak whether things exist.
- **How will I know it's broken in production?** → logs with request ids, metrics, health checks.
- **How do I prove it works?** → tests at the HTTP level, concurrency tests, invariant checks.

## Patterns you can now name (and reuse)

| Pattern | One-line meaning | Where you saw it |
|---|---|---|
| Routes / services split | HTTP code separate from business rules | every module |
| DTO | explicit output objects, nothing leaks | `toUserDto`, `toEventDto` |
| Migrations | versioned schema changes, never edited once run | `src/db/migrations/` |
| Database constraints as rules | the database enforces invariants | `EXCLUDE`, `CHECK`, partial unique indexes |
| Row locking + SKIP LOCKED | take rows exclusively; losers skip instead of waiting | holds, outbox relay |
| Optimistic concurrency | "update only if version unchanged" | optimistic strategy |
| Conditional update | `UPDATE ... WHERE state = expected` as an atomic check | check-in, posters |
| Global lock order | always lock in the same order → no deadlocks | seats → booking → payment |
| Lazy expiry | compute "expired" from a timestamp at read time | `acquirableSql` |
| Transactional outbox | jobs saved in the same transaction as the change | `src/jobs/outbox.ts` |
| Idempotent handler | safe to run twice | `sendOnce`, `expireBooking` |
| Dead-letter queue | failed jobs parked for humans | `runner.ts` |
| Idempotency key | a retried request replays the original response | `lib/idempotency.ts` |
| Reconciliation | re-read the source of truth, don't trust messages | `reconcilePayment` |
| Adapter | wrap an external service behind your own interface | payment providers |
| After-commit effects | notify only after data is saved | `afterCommit` |
| Pub/sub fan-out | one publish reaches all servers' clients | `realtime/` |
| Versioned updates | clients ignore stale or duplicate updates | seat `version` |
| Single-flight cache | concurrent misses share one load | `MicroCache` |
| Generation-keyed cache | invalidate by bumping a counter | `readThrough` |
| Token bucket | burst + sustained rate limit | `rate-limit.ts` |
| Fail fast / load shedding | 429 / 409 / 503 early instead of queueing | ADR 0009 |
| Liveness vs readiness | "alive?" vs "should get traffic?" | `health/` |
| Graceful shutdown | stop taking work, finish, then exit | `server.ts`, `worker.ts` |
| Expand / contract migrations | only add now, remove later | deploys |

## Project ideas to practise with (smallest first)

1. **URL shortener**: one table, a unique constraint on the short code, a redirect route, a click counter (race: two concurrent clicks). Adds: validation, errors, tests.
2. **To-do API with users**: signup/login (copy the auth ideas), ownership checks (you can only see your own tasks), cursor pagination.
3. **Library book lending**: books with copies, "borrow" must not lend the same copy twice (row lock or conditional update), due dates with lazy "overdue" status, a daily reminder job.
4. **Appointment booking for a clinic**: time slots that must not overlap (try an `EXCLUDE` constraint like `events_no_venue_overlap`), holds that expire, email confirmations through a queue.
5. **Live auction**: bids must be strictly higher (concurrency!), live updates over WebSockets with Redis pub/sub, an auction that closes at a timestamp.

For each: write the tables first, add one feature at a time, and write the concurrency test for the core action.

## How to keep learning from this repository

- Read `docs/STUDY-GUIDE.md`: it goes phase by phase with experiments ("remove `.skipLocked()` and rerun the race test") and self-check questions with answers.
- Read the ADRs in `docs/adr/`: each is one page on *why* a decision was made and what alternatives were rejected. Learning the "why" is what lets you make your own decisions.
- Use git as a time machine: `git log --oneline`, then `git show --stat <commit>` to see what each phase added, and `git checkout <commit>` to see the project at that point. Seeing a project grow is the best way to learn how to grow your own.
- Break things on purpose: set `HOLD_STRATEGY=naive` and run `npm run race`; stop the worker, buy a ticket, look at the `outbox` table, start the worker and watch the email arrive.

# Glossary

| Term | Meaning |
|---|---|
| ADR | Architecture Decision Record: a short document explaining one design decision |
| API | the set of requests a server accepts |
| Argon2id | a slow, memory-hard password hashing algorithm |
| At-least-once delivery | a message/job may be delivered more than once, but never zero times |
| Backoff (exponential) | waiting longer after each failed retry: 1 s, 2 s, 4 s, ... |
| Backpressure | slowing or dropping a producer when the consumer can't keep up |
| BullMQ | a job-queue library on Redis |
| Cache | a fast temporary copy of data |
| Claim gate | the Redis pre-check that turns away losing seat holds before Postgres |
| Concurrency | several things happening at the same time |
| Constraint | a rule the database enforces (CHECK, UNIQUE, FOREIGN KEY, EXCLUDE) |
| CSRF | a malicious site making your browser send requests with your cookies; blocked by SameSite cookies |
| Cursor pagination | fetching "the next N after this item" instead of "skip N" |
| Deadlock | two transactions each waiting for a lock the other holds |
| Dead-letter queue | where jobs go after failing all retries |
| DTO | Data Transfer Object: the exact shape sent to clients |
| Drain | letting in-flight work finish while accepting no new work |
| Ed25519 | a public-key signature algorithm (used for tickets) |
| ETag / 304 | a response fingerprint; "not modified" answers save bandwidth |
| Fail open / fail closed | on a dependency failure, allow (open) or deny (closed) |
| Foreign key | a column that must match an id in another table |
| Generation counter | a number in cache keys, bumped on writes to invalidate |
| HMAC | a signature made with a shared secret (used for webhooks and JWTs) |
| Hook (Fastify) | a function run at a stage of every request |
| httpOnly cookie | a cookie JavaScript can't read |
| Idempotent | doing it twice has the same effect as once |
| Idempotency key | a client-chosen id that makes retries safe |
| Index | a data structure that makes lookups fast |
| Invariant | a rule that must always be true ("no seat sold twice") |
| Isolation level | how much concurrent transactions can see of each other |
| Jitter | randomness added to delays so retries don't synchronise |
| JWT | JSON Web Token: signed claims, verifiable without a database |
| Lazy expiry | treating something as expired by checking its timestamp at read time |
| Liveness / readiness | "is the process alive?" / "should it receive traffic?" |
| Load balancer | spreads requests across several servers (Nginx here) |
| Lua script (Redis) | a small program Redis runs atomically |
| Migration | a versioned change to the database structure |
| Optimistic locking | no locks; detect conflicts with a version number at write time |
| ORM | Object-Relational Mapper (like Prisma); this project uses a query builder instead |
| Outbox | a table of jobs written in the same transaction as the change |
| Pessimistic locking | lock rows while reading (`FOR UPDATE`) |
| Plugin (Fastify) | a reusable group of routes/settings |
| Pool (connection pool) | a set of open database connections shared by requests |
| Pub/sub | publish a message to a channel; every subscriber receives it |
| Race condition | a bug caused by unlucky timing between concurrent operations |
| Rate limit | a cap on how many requests a client may make |
| Reconciliation | deriving our state from the source of truth, not from messages |
| Refresh token | a long-lived token used only to get new access tokens |
| Replica | one of several identical copies of a service |
| Reverse proxy | a server in front of your app (Nginx) |
| Rollback | undoing a transaction's changes |
| Schema (Zod) | a description of data's shape, used to validate it |
| Serializable | the strictest isolation level: transactions behave as if one after another |
| Single-flight | concurrent requests for the same thing share one computation |
| SKIP LOCKED | skip rows locked by others instead of waiting |
| SQL injection | an attack where input changes a query; prevented by parameters |
| Token bucket | a rate-limit algorithm allowing bursts plus a steady rate |
| Transaction | a group of changes that all happen or none do |
| UUID | a random 128-bit unique id |
| Webhook | an HTTP request a provider sends you when something happens |
| WebSocket | a long-lived two-way connection between browser and server |
| Worker | a process that runs background jobs |
| XSS | injected scripts running in your page; blocked by CSP and httpOnly cookies |

<div class="end">Happy building.</div>
