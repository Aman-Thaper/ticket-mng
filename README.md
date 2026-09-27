# ticket_mng

An event ticketing backend built phase by phase to practise the hard parts: concurrency, money, expiry, live updates and load.

**Stack:** Node 24 · TypeScript · Fastify 5 · Zod 4 (validation, serialization and OpenAPI from one schema) · PostgreSQL · Kysely (typed SQL builder, no ORM magic) · Vitest

## Roadmap

| Phase | Scope                                                                                               | Status |
| ----- | --------------------------------------------------------------------------------------------------- | ------ |
| 1     | Core API + schema: users, venues, seat layouts, events, seat inventory, search, pagination, Swagger | ✅     |
| 2     | Auth: argon2, access + refresh tokens, password reset, roles/ownership                              | ✅     |
| 3     | Seat holds (10 min) + booking, race-condition test (200 concurrent requests), locking               |        |
| 4     | Workers (BullMQ): QR ticket emails, poster uploads to MinIO, scheduled jobs, DLQ                    |        |
| 5     | Payments + webhooks, idempotency keys, booking state machine                                        |        |
| 6     | Flash sale: k6, Redis cache, rate limiting, WebSockets + pub/sub, 3 instances behind Nginx          |        |
| 7     | Docker Compose, CI, structured logs, metrics, deploy                                                |        |

## Setup

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
npm run dev         # http://localhost:3000/docs
```

| Script                             |                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `npm run dev`                      | API with reload on save                                                      |
| `npm test`                         | unit + API integration tests (API tests use `TEST_DATABASE_URL` and wipe it) |
| `npm run test:unit`                | unit tests only, no DB needed                                                |
| `npm run migrate` / `migrate:down` | apply all migrations / roll back the last one                                |
| `npm run seed`                     | **wipes** the dev DB and loads realistic volume                              |
| `npm run typecheck`                | `tsc --noEmit`                                                               |

## Layout

```
src/
  app.ts                 Fastify setup: Zod compilers, Swagger, error handler, routes
  server.ts              entry point + graceful shutdown
  config.ts              env vars, validated at boot (fail fast)
  db/
    migrations/          plain-SQL migrations (never edit one that has run)
    types.ts             table types for Kysely
  lib/
    errors.ts            AppError + the single error handler
    pagination.ts        keyset cursor encode/decode
  modules/<resource>/    routes + schemas per resource
scripts/seed.ts
test/unit, test/api
```

## API

All routes are under `/api/v1`. Interactive docs are at `/docs`, and the raw spec is at `/docs/json`.

| Method     | Path                                       | Notes                                                                                                                   |
| ---------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| POST       | `/auth/signup`, `/auth/login`              | returns an access token; sets the refresh token as an httpOnly cookie                                                   |
| POST       | `/auth/refresh`                            | rotates the refresh cookie; reusing an old one revokes the session                                                      |
| POST       | `/auth/logout`, `/auth/logout-all`         | revoke this session / every session                                                                                     |
| GET/DELETE | `/auth/sessions[/:id]`                     | list and revoke your logged-in devices                                                                                  |
| POST       | `/auth/password/change`                    | revokes your other sessions                                                                                             |
| POST       | `/auth/password-reset/request`, `/confirm` | emailed single-use token (30 min)                                                                                       |
| GET/PATCH  | `/users/me`                                | your profile                                                                                                            |
| GET        | `/users/:id`                               | admin                                                                                                                   |
| PATCH      | `/users/:id/role`                          | admin; revokes the user's sessions                                                                                      |
| POST       | `/venues`                                  | organizer/admin; generates seats from `sections: [{name, rows, seatsPerRow}]`                                           |
| GET        | `/venues`                                  | `q`, `city`, `limit`, `offset`                                                                                          |
| GET        | `/venues/:id`                              | includes section summary                                                                                                |
| POST       | `/events`                                  | creates a **draft** and copies venue seats into priced inventory                                                        |
| GET        | `/events`                                  | `q` (full-text), `city`, `category`, `venueId`, `organizerId`, `status`, `from` (default: now), `to`, `limit`, `cursor` |
| GET        | `/events/:id`                              | includes `seats {total, available}` and `priceRange`                                                                    |
| PATCH      | `/events/:id`                              | partial update and status transitions                                                                                   |
| DELETE     | `/events/:id`                              | drafts only (others must be cancelled)                                                                                  |
| GET        | `/events/:id/seats`                        | seat map grouped by section, with x/y, price and status                                                                 |
| GET        | `/health`                                  | DB ping                                                                                                                 |

**Errors** always have the shape `{ "error": { "code", "message", "details?" } }`.

| Status | Meaning                                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------- |
| 400    | Malformed input (`VALIDATION_ERROR` with per-field `details`, `INVALID_CURSOR`)                         |
| 404    | Resource doesn't exist                                                                                  |
| 409    | Conflicts with current state (`EMAIL_TAKEN`, `VENUE_TIME_CONFLICT`, `INVALID_STATUS_TRANSITION`, ...)   |
| 422    | Well-formed but semantically invalid, e.g. a referenced venue doesn't exist or pricing misses a section |

## Design notes

These are worth being able to explain in an interview.

- **Venue layout vs event inventory.** `venue_seats` is the physical template. `event_seats` is one row per sellable seat _per event_, with its own price and status. Booking (Phase 3) locks `event_seats` rows, and the venue layout is never touched after creation.
- **The database enforces invariants, not just the app.** The `events_no_venue_overlap` constraint (`EXCLUDE USING gist (venue_id WITH =, tstzrange(starts_at, ends_at) WITH &&)`) makes double-booking a _venue_ impossible even under concurrent requests. A test fires 20 parallel creates and asserts exactly one wins. That's the same idea Phase 3 applies to seats.
- **Keyset pagination on `/events`** (`WHERE (starts_at, id) > cursor`) backed by the index `(status, starts_at, id)`. Page 10,000 is as fast as page 1. `/venues` uses offset pagination for contrast, which is fine for a small table that needs "page 3 of 12".
- **Full-text search** uses a generated `tsvector` column with a GIN index, `websearch_to_tsquery` (which supports `"quoted phrases"` and `-exclusions`), title weighted above description.
- **Bulk inserts with `unnest(arrays)`.** Creating a 50k-seat venue or event is a single `INSERT … SELECT`, with no per-row round trips and no bind-parameter limit.
- **`SELECT … FOR UPDATE` in `PATCH /events/:id`** keeps two concurrent status changes from both reading `draft` and acting on stale state. This is a small preview of Phase 3.
- **Response DTOs everywhere.** Rows are never returned directly, so the `password_hash` column arriving in Phase 2 can't leak.

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
