# ticket_mng

An event ticketing backend, built in seven phases to practise the hard parts: concurrency, money, expiry, live updates, load, and shipping it.

**Stack:** Node 24 · TypeScript · Fastify 5 · Zod 4 (validation, serialization and OpenAPI from one schema) · PostgreSQL 18 · Kysely (typed SQL, no ORM) · Redis · BullMQ · WebSockets · Nginx · Docker · Prometheus + Grafana · Vitest, Playwright, k6 · GitHub Actions

**Docs:** [Architecture](docs/ARCHITECTURE.md) (diagrams of every flow) · [Decision records](docs/adr/) (why each choice) · [Study guide](docs/STUDY-GUIDE.md) (how to learn this codebase) · [Deploying](docs/DEPLOY.md) (VPS, HTTPS, zero-downtime rollouts) · [Beginner's guide (PDF)](docs/BEGINNER-GUIDE.pdf) (every part explained from zero)

## Roadmap

| Phase | Scope                                                                                                      | Status |
| ----- | ---------------------------------------------------------------------------------------------------------- | ------ |
| 1     | Core API + schema: users, venues, seat layouts, events, seat inventory, search, pagination, Swagger        | ✅     |
| 2     | Auth: argon2, access + refresh tokens, password reset, roles/ownership                                     | ✅     |
| 3     | Seat holds (10 min) + booking, race-condition test (200 concurrent requests), locking                      | ✅     |
| 4     | Workers (BullMQ): QR ticket emails, poster uploads to MinIO, scheduled jobs, DLQ                           | ✅     |
| 5     | Payments + webhooks, idempotency keys, booking state machine                                               | ✅     |
| 6     | Flash sale: k6, Redis cache, rate limiting, WebSockets + pub/sub, 3 instances behind Nginx                 | ✅     |
| 7     | Docker, CI, structured logs with request ids, health checks, metrics, HTTPS deploy, zero-downtime rollouts | ✅     |

## Run it

**Everything in Docker** (3 API replicas behind Nginx, worker, Postgres, Redis, MinIO, Mailpit):

```bash
docker compose up -d --build
# demo data (~1 minute; every seeded user's password is password123)
cp .env.example .env && npm install
DATABASE_URL=postgres://ticket:ticket@localhost:5433/ticket_mng REDIS_URL=redis://localhost:6380/0 npm run seed
```

Then open http://localhost:8080 (seat map; log in with the prefilled demo account), http://localhost:8080/docs (API), http://localhost:8025 (emails). Add `docker compose --profile monitoring up -d` for Prometheus (:9090) and Grafana (:3030, dashboard included). `docker compose down` stops it; add `-v` to delete the data too.

**Native development** (fast reloads, debugger):

```bash
# 1. Create a role and two databases (dev + test). Uses your Postgres superuser.
psql -U postgres -h localhost \
  -c "CREATE ROLE ticket LOGIN PASSWORD 'ticket';" \
  -c "CREATE DATABASE ticket_mng OWNER ticket;" \
  -c "CREATE DATABASE ticket_mng_test OWNER ticket;"

# 2. Local infrastructure: Redis, Mailpit (SMTP catcher) and MinIO (S3)
brew install redis mailpit minio
scripts/dev-services.sh start

# 3. Configure, migrate, seed, run
cp .env.example .env
npm install
npm run migrate
npm run seed        # optional: ~1.5M rows, ~30 s. Every seeded user's password is password123
npm run dev         # API: http://localhost:3000/docs
npm run worker      # background jobs + outbox relay (second terminal)
```

| Script                                        |                                                                                         |
| --------------------------------------------- | --------------------------------------------------------------------------------------- |
| `npm run dev`                                 | API with reload on save                                                                 |
| `npm run worker`                              | background worker with reload on save                                                   |
| `npm test`                                    | unit + API integration tests (API tests use `TEST_DATABASE_URL` and wipe it)            |
| `npm run test:unit`                           | unit tests only, no DB needed                                                           |
| `npm run migrate` / `migrate:down`            | apply all migrations / roll back the last one                                           |
| `npm run seed`                                | **wipes** the dev DB and loads realistic volume                                         |
| `npm run race`                                | 200 concurrent holds on one seat, per locking strategy (see below)                      |
| `scripts/cluster.sh start`                    | 3 API instances + worker behind Nginx on :8080 (`loadtest` mode lifts the per-IP limit) |
| `npm run loadtest:setup` + `npm run loadtest` | k6 flash sale (needs the cluster in `loadtest` mode)                                    |
| `npm run check:invariants`                    | audit the database: no seat sold twice, no money kept for nothing, ...                  |
| `npm run e2e`                                 | headless-browser test of the live seat map (buyer + watcher)                            |
| `npm run typecheck`                           | `tsc --noEmit`                                                                          |
| `npm run lint` / `format`                     | ESLint (type-aware) / Prettier                                                          |
| `npm run build` + `npm start`                 | compile to `dist/` and run it the way production does                                   |
| `docker compose up -d --build`                | the whole system in containers on :8080 (see [Run it](#run-it))                         |
| `deploy/rollout.sh`                           | replace the API containers with a new build without dropping a request                  |

## Layout

```
src/            server.ts (API) · worker.ts (jobs) · app.ts · config.ts
  db/           pool, transactions, migrations
  lib/          errors, logging, metrics, caching, rate limits, idempotency, invariants, ...
  modules/      one folder per area: auth, users, venues, events, bookings, payments, tickets, admin, health
  jobs/         queues, outbox relay, job runner, handlers, schedules
  realtime/     live seat-map hub (WebSockets + Redis pub/sub)
  fake-gateway/ Stripe-shaped payment provider for offline development
public/         the seat-map page
scripts/        seed, race test, load tests, e2e test, invariant check, local cluster
deploy/         Nginx configs, monitoring, production compose, rollout script
docs/           architecture, decision records, study guide, deployment
test/           unit + HTTP integration tests (Vitest)
```

A file-by-file map is in [ARCHITECTURE.md](docs/ARCHITECTURE.md#source-map).

## API

All routes are under `/api/v1`. Interactive docs are at `/docs`, and the raw spec is at `/docs/json`.

| Method          | Path                                                  | Notes                                                                                                                   |
| --------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| POST            | `/auth/signup`, `/auth/login`                         | returns an access token; sets the refresh token as an httpOnly cookie                                                   |
| POST            | `/auth/refresh`                                       | rotates the refresh cookie; reusing an old one revokes the session                                                      |
| POST            | `/auth/logout`, `/auth/logout-all`                    | revoke this session / every session                                                                                     |
| GET/DELETE      | `/auth/sessions[/:id]`                                | list and revoke your logged-in devices                                                                                  |
| POST            | `/auth/password/change`                               | revokes your other sessions                                                                                             |
| POST            | `/auth/password-reset/request`, `/confirm`            | emailed single-use token (30 min)                                                                                       |
| GET/PATCH       | `/users/me`                                           | your profile                                                                                                            |
| GET             | `/users/:id`                                          | admin                                                                                                                   |
| PATCH           | `/users/:id/role`                                     | admin; revokes the user's sessions                                                                                      |
| POST            | `/venues`                                             | organizer/admin; generates seats from `sections: [{name, rows, seatsPerRow}]`                                           |
| GET             | `/venues`                                             | `q`, `city`, `limit`, `offset`                                                                                          |
| GET             | `/venues/:id`                                         | includes section summary                                                                                                |
| POST            | `/events`                                             | creates a **draft** and copies venue seats into priced inventory                                                        |
| GET             | `/events`                                             | `q` (full-text), `city`, `category`, `venueId`, `organizerId`, `status`, `from` (default: now), `to`, `limit`, `cursor` |
| GET             | `/events/:id`                                         | includes `seats {total, available}` and `priceRange`                                                                    |
| PATCH           | `/events/:id`                                         | partial update and status transitions                                                                                   |
| DELETE          | `/events/:id`                                         | drafts only (others must be cancelled)                                                                                  |
| GET             | `/events/:id/seats`                                   | seat map grouped by section, with x/y, price and status                                                                 |
| GET (WebSocket) | `/events/:id/live`                                    | live seat updates: `hello`, then `[seatId, status, version]` batches                                                    |
| POST            | `/events/:id/bookings`                                | hold seats for 10 min (pending booking); 409 if taken                                                                   |
| GET             | `/bookings`, `/bookings/:id`                          | your bookings (cursor pagination) / one booking                                                                         |
| POST            | `/bookings/:id/payment`                               | start paying: payment intent + client secret (idempotent per booking)                                                   |
| POST            | `/bookings/:id/refund`                                | refund a confirmed booking (until 24 h before the event)                                                                |
| POST            | `/webhooks/:provider`                                 | provider webhooks: signature-verified, deduplicated, queued                                                             |
| POST            | `/fake-gateway/v1/payment_intents/:id/confirm`        | dev only: pay with a test card (4242…, 4000…0002 declined)                                                              |
| POST            | `/bookings/:id/cancel`                                | release a pending hold                                                                                                  |
| GET             | `/bookings/:id/tickets`                               | QR tickets (signed tokens + PNG data URLs)                                                                              |
| POST            | `/check-in`                                           | organizer scans a QR code; each ticket admits once                                                                      |
| GET             | `/tickets/public-key`                                 | Ed25519 key for verifying tickets offline                                                                               |
| POST            | `/events/:id/poster/upload-url`                       | presigned POST: upload straight to S3/MinIO                                                                             |
| PUT             | `/events/:id/poster`                                  | queue resizing of an uploaded poster (202)                                                                              |
| GET             | `/admin/queues`, `/admin/dead-letters`                | queue depths, outbox backlog, failed jobs (admin)                                                                       |
| GET             | `/admin/invariants`                                   | audit the business rules: no seat sold twice, no money kept for nothing, ... (admin)                                    |
| POST/DELETE     | `/admin/dead-letters/:id[/retry]`                     | requeue or discard a dead job (admin)                                                                                   |
| GET             | `/health/live`, `/health/ready` (not under `/api/v1`) | liveness (process answers) / readiness (DB + Redis reachable, not shutting down; 503 otherwise)                         |
| GET             | `/metrics` (not under `/api/v1`)                      | Prometheus metrics; not exposed through Nginx, optional bearer token (`METRICS_TOKEN`)                                  |

**Errors** always have the shape `{ "error": { "code", "message", "details?" } }`.

| Status | Meaning                                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------- |
| 400    | Malformed input (`VALIDATION_ERROR` with per-field `details`, `INVALID_CURSOR`)                         |
| 401    | Missing, invalid or expired access token (`UNAUTHENTICATED`, with `WWW-Authenticate`)                   |
| 403    | Authenticated but not allowed (`FORBIDDEN`)                                                             |
| 404    | Resource doesn't exist, or you may not know it exists (other people's drafts)                           |
| 409    | Conflicts with current state (`EMAIL_TAKEN`, `VENUE_TIME_CONFLICT`, `INVALID_STATUS_TRANSITION`, ...)   |
| 422    | Well-formed but semantically invalid, e.g. a referenced venue doesn't exist or pricing misses a section |
| 429    | Rate limited (`RATE_LIMITED`), with `Retry-After`                                                       |
| 503    | Overloaded or momentarily conflicting (`SERVICE_BUSY`, `TRANSIENT_CONFLICT`), with `Retry-After`: retry |

Every response carries `x-request-id` (send your own `X-Request-Id` to correlate); quote it when reporting a problem.

## Design notes

These are worth being able to explain in an interview.

- **Venue layout vs event inventory.** `venue_seats` is the physical template. `event_seats` is one row per sellable seat _per event_, with its own price and status. Booking (Phase 3) locks `event_seats` rows, and the venue layout is never touched after creation.
- **The database enforces invariants, not just the app.** The `events_no_venue_overlap` constraint (`EXCLUDE USING gist (venue_id WITH =, tstzrange(starts_at, ends_at) WITH &&)`) makes double-booking a _venue_ impossible even under concurrent requests. A test fires 20 parallel creates and asserts exactly one wins. That's the same idea Phase 3 applies to seats.
- **Keyset pagination on `/events`** (`WHERE (starts_at, id) > cursor`) backed by the index `(status, starts_at, id)`. Page 10,000 is as fast as page 1. `/venues` uses offset pagination for contrast, which is fine for a small table that needs "page 3 of 12".
- **Full-text search** uses a generated `tsvector` column with a GIN index, `websearch_to_tsquery` (which supports `"quoted phrases"` and `-exclusions`), title weighted above description.
- **Bulk inserts with `unnest(arrays)`.** Creating a 50k-seat venue or event is a single `INSERT … SELECT`, with no per-row round trips and no bind-parameter limit.
- **`SELECT … FOR UPDATE` in `PATCH /events/:id`** keeps two concurrent status changes from both reading `draft` and acting on stale state. This is a small preview of Phase 3.
- **Response DTOs everywhere.** Rows are never returned directly, so the `password_hash` column arriving in Phase 2 can't leak.

## How double booking is prevented

Seat rows are the single source of truth. Taking a seat means setting `event_seats.booking_id` and `status = 'held'` inside a transaction, and a check constraint enforces _available ⇔ no booking_. `npm run race` sends 200 simultaneous HTTP requests for the same seat under each strategy:

| Strategy           | 201s | Owners in DB | Reached Postgres | How it works                                                                    |
| ------------------ | ---- | ------------ | ---------------- | ------------------------------------------------------------------------------- |
| naive              | 11   | **11** ✗     | 200              | read, check, write with no locks: every reader of "available" writes            |
| optimistic         | 1    | 1            | 200              | `UPDATE … WHERE version = <read version>`; losers match 0 rows                  |
| serializable       | 1    | 1            | 200              | SERIALIZABLE transaction; Postgres aborts conflicts (40001), retries see "held" |
| pessimistic        | 1    | 1            | 200              | `SELECT … FOR UPDATE SKIP LOCKED`; losers skip the locked row and fail fast     |
| pessimistic + gate | 1    | 1            | **30**           | Redis `SET NX` claim first; 170 losers never touch Postgres                     |

Pessimistic + gate is the default. Supporting pieces:

- **Holds are pending bookings** with `expires_at`. A lapsed hold counts as free immediately (lazy expiry, judged by the database clock), so correctness never depends on a background job.
- **One lock order everywhere**: seat rows (ascending id), then booking rows, so confirming, cancelling, expiring and holding can't deadlock one another.
- **One active hold per user per event**: a partial unique index. It stops double-clicks and seat hoarding, and makes the per-user ticket limit race-free.
- **The Redis claim gate is a load shield, not a lock**: TTL locks in Redis can't guarantee mutual exclusion, so Postgres still decides who gets the seat.

## Background jobs

The API process answers requests. A separate worker process (`src/worker.ts`) does everything slow or scheduled. They share one codebase and talk through Postgres and Redis.

| Job                            | Trigger                                         | Notes                                                                      |
| ------------------------------ | ----------------------------------------------- | -------------------------------------------------------------------------- |
| `email/booking-confirmed`      | booking confirmed                               | QR tickets inline; sent at most once (notification log + row lock)         |
| `email/password-reset`         | reset requested                                 | account lookup happens here, so response time can't reveal who has one     |
| `email/event-reminder`         | `maintenance/send-event-reminders` (every 15 m) | events starting in ~24 h; one per booking                                  |
| `bookings/expire-booking`      | hold placed (delayed to its deadline)           | releases seats; correctness never waited for it (lazy expiry)              |
| `bookings/sweep-expired-holds` | every 30 s                                      | safety net for lost jobs and orphaned seats                                |
| `media/process-poster`         | poster attached                                 | sharp → 320/640/1280 px WebP, public and cache-forever; rejects non-images |
| `maintenance/cleanup`          | 03:00 UTC daily                                 | old outbox rows, expired tokens and sessions, in batches                   |

- **Transactional outbox.** The API never enqueues directly: it inserts an `outbox` row in the same transaction as the business change. The relay (in the worker, woken by `LISTEN/NOTIFY`, polling as a fallback) publishes rows to BullMQ with a fixed job id, so re-publishing after a crash is a no-op. Result: no email for a rolled-back booking, and no lost email for a committed one.
- **Retries:** 5 attempts, exponential backoff with ±50% jitter. **Dead-letter queue:** jobs that exhaust their retries, or throw `UnrecoverableError`, are copied to `dead-letter` for an admin to inspect, retry or discard.
- **Tickets** are signed with Ed25519: `version‖ticketId‖eventId` plus the signature, about 130 characters, so the QR code stays small. Scanners verify with the public key alone. Check-in is one conditional `UPDATE … WHERE checked_in_at IS NULL`, so a ticket admits exactly once, and a partial unique index guarantees one valid ticket per seat.
- **Posters** never pass through the API: a presigned POST (fixed key, ≤ 10 MB, `image/*`) goes straight to storage, and the worker does the CPU-heavy resize.

## Payments

`PAYMENT_PROVIDER=fake` (the default) runs a built-in, Stripe-shaped gateway, so the whole flow works offline. `PAYMENT_PROVIDER=stripe` with `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` uses Stripe in test mode, with `stripe listen --forward-to localhost:3000/api/v1/webhooks/stripe` for local webhooks.

```
POST /bookings/:id/payment  →  client secret  →  browser pays at the provider
provider ──signed webhook──▶ POST /webhooks/:provider ──▶ webhook_events (dedupe) + outbox
worker: fetch the payment's CURRENT state from the provider ──▶ confirm booking + record payment (one transaction)
```

| Problem                               | Handling                                                                                                                         |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Forged webhooks                       | HMAC-SHA256 over the **raw** body, constant-time compare, 5-minute timestamp window (replays rejected)                           |
| Webhooks delivered twice              | `webhook_events` primary key (provider, event id); the second copy is acknowledged and ignored                                   |
| Webhooks out of order                 | processing ignores the event body and re-fetches the provider's current state, so every order converges                          |
| A retried POST books or charges twice | `Idempotency-Key` on holds (replay the stored response); provider calls carry idempotency keys; one open payment per booking     |
| Paid just after the hold expired      | seats still free → re-taken and confirmed; seats sold to someone else → payment recorded, **refunded automatically**, email sent |
| Charged twice for one booking         | the second payment is refunded as `duplicate_payment`                                                                            |
| Event cancelled                       | a job refunds every paid booking (one refund per payment, enforced by a unique index); open holds are voided                     |
| Refund requested                      | until 24 h before the event; seats and tickets are released only once the provider confirms the refund                           |

Try chaos mode (`FAKE_GATEWAY_CHAOS=true`): every webhook is delivered twice, after random delays, so they can arrive out of order. Bookings still end up in exactly the right state.

## The flash sale

**Demo:** open `http://localhost:3000/` (or `:8080` through the cluster) in two browser windows. Log in on one (the demo account is prefilled), then hold and pay for seats; the other window's seat map changes live.

| Concern                         | How                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live seat maps across instances | Every seat change is published to Redis (`seats:<event>`) **after commit**. Each API instance subscribes only to events its WebSocket clients watch, batches updates for 100 ms (newest version per seat wins) and drops clients that fall 1 MiB behind. Clients subscribe first, then load the snapshot, and apply updates by version, so no change is missed or applied twice. |
| Caching: hot, changing data     | Seat maps and live counts: in-process micro-cache, 1 s, single-flight (a thousand concurrent misses cost one query), ETag → 304. Never invalidated; the WebSocket keeps clients current.                                                                                                                                                                                         |
| Caching: rarely changing data   | Event pages and public listings: Redis read-through keyed by **generation counters**, bumped after commit on every write. A slow reader can only write stale data under a generation nobody reads any more.                                                                                                                                                                      |
| Rate limiting                   | Per client IP on the whole API, a Redis token bucket shared by all instances. Also per user on holds and per account on login. `TRUST_PROXY=loopback` makes the IP the real client's, and clients can't spoof it.                                                                                                                                                                |
| Connection pooling              | `DB_POOL_MAX` per process (3 × 20 + worker 10 < Postgres' 100). A request waits at most 5 s for a connection, then gets **503 + Retry-After** instead of hanging. Postgres itself kills statements after 15 s and abandoned transactions after 30 s.                                                                                                                             |
| Stateless instances             | Sessions, holds, rate limits, caches, idempotency keys, fan-out and the fake gateway's state all live in Postgres or Redis. Any instance can serve any request, and killing one loses nothing.                                                                                                                                                                                   |

### Load test results

k6 (`scripts/loadtest/flash-sale.js`): buyers arrive at a fixed rate; each loads the seat map and tries to hold 1–2 random seats of a 2,000-seat event. 3 API instances + worker behind Nginx, **everything including k6 on one fanless MacBook Air (M2, 8 GB)**, so these are lower bounds.

| Arrival rate                 | Requests/s | 5xx       | Hold p95 | Seat map p95 | Notes                                                                            |
| ---------------------------- | ---------- | --------- | -------- | ------------ | -------------------------------------------------------------------------------- |
| 300 buyers/s                 | 503        | 0         | 15 ms    | 10 ms        | 1,937 seats held; 13,613 correct 409s once sold out                              |
| 600 buyers/s                 | 992        | 0         | 95 ms    | 15 ms        | sold out (1,996 of 2,000)                                                        |
| 1,000 buyers/s (first run)   | 460        | **3,746** | 4.1 s    | 3.5 s        | **cascading failure**, see below                                                 |
| 1,000 buyers/s (after fixes) | **1,197**  | **0**     | 1.4 s    | 0.4 s        | at the laptop's ceiling (CPU + thermal throttling): latency rises, nothing fails |

After every run, `npm run check:invariants` reported zero violations: no seat sold twice, even through the overload.

**What the first 1,000/s run taught:**

1. **Nginx turned graceful overload into an outage.** The API shed load with 503 + Retry-After when its pool was busy, but `proxy_next_upstream http_503` made Nginx count those as server failures. After `max_fails`, it marked all three instances dead and answered everything with 502 "no live upstreams". The fix: only retry connection errors (`proxy_next_upstream error timeout`).
2. **`NOTIFY` on every hold serialized commits.** Each hold's outbox row (its 10-minute expiry job) fired `pg_notify`, which takes a global lock at commit. Migration 0006 notifies only for jobs that are due now.
3. **Retries need idempotency.** k6 counted 1,942 held seats and the database had 1,944: two holds committed but their responses were lost in the outage. A client retrying with the same `Idempotency-Key` gets exactly those bookings back.

## Shipping it

One image runs as the API, the worker or the migrations (multi-stage build, non-root, `tini` as PID 1). `docker compose up` gives the full system locally; `deploy/docker-compose.prod.yml` layers on HTTPS (Let's Encrypt, auto-renewed), Stripe, secrets from `.env.production`, log rotation and resource limits. [DEPLOY.md](docs/DEPLOY.md) walks through a VPS from scratch.

| Concern             | How                                                                                                                                                                                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Logs                | JSON lines (pino) with the request id. Nginx generates the id and logs it too, and jobs log the id of the request that caused them (it rides along in the outbox), so one search follows a purchase from the proxy through the API to the email. Secrets are redacted. |
| Metrics             | Prometheus on every API replica and the worker: latency by route template, in-flight requests, pool usage and waiters, cache hit rates, hold outcomes, job durations, queue depths, outbox age, WebSocket connections, event-loop lag. Grafana dashboard provisioned.  |
| Health              | `/health/live` never checks dependencies (so an outage can't cause restart loops); `/health/ready` checks Postgres and Redis and turns false during shutdown.                                                                                                          |
| Graceful shutdown   | SIGTERM: report not ready, optionally keep serving for `SHUTDOWN_DRAIN_MS` (for load balancers that poll readiness), finish in-flight requests, close WebSockets with 1001 so browsers reconnect elsewhere, close pools.                                               |
| CI (GitHub Actions) | lint, format, types, build → tests against real Postgres, Redis, MinIO and stripe-mock → Docker image (pushed to GHCR from `main`) → the whole stack in compose: browser e2e, a k6 load test, a zero-downtime rollout under traffic, the invariant audit.              |
| Deploys             | A manual workflow: migrations first (they only ever add, so rollback is redeploying an older image), then `deploy/rollout.sh`, then the worker.                                                                                                                        |

**Zero-downtime deploys, measured.** `docker compose up -d` stops every replica before the new ones can serve. Under 65 requests/s, that failed 336 of 2,927 requests. Starting new replicas first and then stopping the old ones still failed 3: Nginx keeps sending requests to a stopped container's address until its DNS refresh, and those requests end in 502. `deploy/rollout.sh` moves Nginx onto the new replicas (a graceful reload) _before_ stopping the old ones: **0 of 2,927** failed. The full story is in [DEPLOY.md](docs/DEPLOY.md#why-a-rollout-script).

## Exercise: watch an index work

After `npm run seed`:

```sql
EXPLAIN ANALYZE
SELECT id, title, starts_at FROM events
WHERE status = 'published' AND starts_at >= now()
ORDER BY starts_at, id LIMIT 20;

BEGIN;
DROP INDEX events_listing_idx;   -- run the query again inside this transaction
ROLLBACK;                        -- DDL is transactional in Postgres, so the index comes back
```

Measured on the seeded data (M-series Mac, Postgres 18):

| Query                       | With index                 | Without                                 |
| --------------------------- | -------------------------- | --------------------------------------- |
| Upcoming events, first page | 1.6 ms (Index Scan)        | 152 ms (Parallel Seq Scan + top-N sort) |
| Full-text `jazz`            | 1.7 ms (Bitmap Index Scan) | 26 ms (Parallel Seq Scan)               |

Try the same with `events_search_idx` and a `search @@ websearch_to_tsquery('english', 'jazz')` query.
