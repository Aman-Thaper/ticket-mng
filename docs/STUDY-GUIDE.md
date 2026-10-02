# Study guide

A route through this codebase, phase by phase: what each part teaches, which files to read in which order, experiments to run, and questions to check yourself with (answers are folded under each question). Budget one or two sessions per phase.

**Before you start**

1. Run it (the [README](../README.md#run-it) has both ways) and play: sign up in `/docs`, open the seat map (`/`) in two windows, hold and pay in one and watch the other.
2. Read [ARCHITECTURE.md](ARCHITECTURE.md) once, quickly. Don't try to understand everything yet; it's the map you'll come back to.
3. Use git as a time machine. Each phase is one commit, so you can see what that phase added:

   ```bash
   git log --oneline                     # one commit per phase
   git show --stat <commit>              # which files that phase touched
   git checkout <commit>                 # the project as it was after that phase (git checkout main to return)
   ```

---

## Phase 1: core API, schema, search, pagination

**Teaches:** how a request becomes a validated, typed, documented operation; schema design; indexes; pagination that stays fast.

**Read, in order:**

1. `src/config.ts`: configuration validated at boot. Why fail at startup rather than at first use?
2. `src/app.ts`: how Fastify is assembled (compilers, error handler, plugins, route prefixes).
3. `src/db/migrations/0001_initial_schema.ts`: tables, enums, the exclusion constraint, the generated search column, indexes.
4. `src/modules/venues/routes.ts`, then `src/modules/events/routes.ts` and `schemas.ts`: a full resource. Notice how one Zod schema serves validation, types and docs.
5. `src/lib/pagination.ts` and the events list query: keyset pagination.
6. `src/lib/errors.ts`: one error shape; mapping Postgres errors to HTTP.

**Try:**

- Run the index exercise at the end of the README (`EXPLAIN ANALYZE` with and without `events_listing_idx`).
- Create two events at the same venue with overlapping times, concurrently (the test "20 parallel creates for one slot, exactly one wins" in `test/api/events.test.ts` does this). Only one succeeds. Why is a check in application code not enough?

**Questions:**

<details><summary>Why keyset (cursor) pagination for events but offset pagination for venues?</summary>

`OFFSET 100000` makes Postgres read and discard 100,000 rows, so deep pages get slower and rows shift when data changes between pages. Keyset (`WHERE (starts_at, id) > (cursor)`) jumps straight there using the index, at the same cost on any page, and is stable under inserts. Offset is fine for small tables where users want "page 3 of 12".
</details>

<details><summary>Times are stored in UTC. Whose time zone should a page show them in?</summary>

The venue's. A show starts at 7:30 PM in Toronto for everyone; showing it in each viewer's zone would print a different time on every screen and on none of the tickets. So each venue has an IANA time zone (`venues.timezone`, migration 0009) and `Intl.DateTimeFormat({ timeZone })` formats with it. Store instants (UTC), display wall-clock times where the event happens, and never store "local time without a zone".
</details>

<details><summary>Why copy venue seats into event_seats instead of booking venue seats directly?</summary>

The venue is a physical template; each event sells its own inventory with its own prices and status. Booking one event must not lock or change the template or other events' seats, and event rows can carry per-event state (status, booking, version).
</details>

<details><summary>What does the exclusion constraint give you that a SELECT-then-INSERT check doesn't?</summary>

Atomicity under concurrency: two transactions can both check "no overlap" before either inserts. The constraint is checked by the database at insert time with the right locking, so exactly one of them wins. (It also produced deadlocks under concurrency, fixed by locking the venue row first: see `git log -p` for the event creation code.)
</details>

---

## Phase 2: authentication and authorization

**Teaches:** password storage, token design, sessions and revocation, reading the threat model into code.

**Read, in order:**

1. `src/modules/auth/passwords.ts`: Argon2id, timing-equalized failures, rehash on login.
2. `src/modules/auth/tokens.ts`: JWT creation and verification (why pin the algorithm?).
3. `src/modules/auth/sessions.ts`: sessions, refresh rotation, reuse detection, the denylist.
4. `src/modules/auth/routes.ts`: login, refresh, logout, password reset. Notice the cookie attributes.
5. `src/modules/auth/guard.ts`: how routes require a user or a role.
6. `src/modules/auth/verification.ts` and `public/session.js`: email confirmation, and how the pages keep a session (access token in memory, refresh cookie, `?next=` redirects).
7. [ADR 0006](adr/0006-auth-tokens-and-sessions.md), [ADR 0011](adr/0011-email-verification.md).

**Try:** log in, call `POST /auth/refresh` twice with the _same_ old cookie (copy it from the first response). The second use revokes the session. Why is that the right reaction?

**Questions:**

<details><summary>Why a short-lived access token plus a refresh token, instead of one long-lived token?</summary>

A JWT can't be revoked once issued (verification needs no lookup), so its lifetime bounds the damage of a leak: 15 minutes. The refresh token is long-lived but only ever sent to `/api/v1/auth` (cookie path), stored hashed, rotated on use, and revocable in the database.
</details>

<details><summary>How can a logout take effect immediately if access tokens are stateless?</summary>

The session id is inside the token. Revoking a session also writes its id to a Redis denylist (for the token's remaining lifetime), and the guard checks that denylist. It fails open if Redis is down: availability over a 15-minute revocation delay.
</details>

<details><summary>Why is the confirmation token created by the worker, not in the signup request?</summary>

The request only records "send this user a confirmation email" in the outbox. If it created the token, the raw secret would sit in the outbox table and in Redis job data until the job ran. Minting it in the worker means it exists only in the email and, hashed, in the database.
</details>

<details><summary>Why can't a login link's ?next= be used to send visitors to another site?</summary>

`nextPath()` in `public/session.js` only accepts paths starting with a single `/`. `//evil.example` (a protocol-relative URL), `https://…` and `javascript:` are rejected. Without that check, a login page is an open redirect: a phishing link could log you in on the real site, then send you somewhere else.
</details>

<details><summary>Why is the password reset token in the URL fragment (#token=...)?</summary>

Browsers never send the fragment to servers, so it doesn't end up in access logs, proxies, or `Referer` headers to third parties. The page's JavaScript reads it and posts it.
</details>

---

## Phase 3: seat holds and the race condition

**Teaches:** race conditions, row locks, isolation levels, optimistic concurrency, deadlock avoidance, designing for expiry.

**Read, in order:**

1. `src/db/migrations/0003_bookings.ts`: the seat/booking columns, the `CHECK`, the partial unique index.
2. The big comment at the top of `src/modules/bookings/service.ts`, then `holdSeats`, the strategies, and `acquirableSql`.
3. `src/modules/bookings/claims.ts`: the Redis claim gate (and why it isn't a lock).
4. `src/db/transaction.ts`: retries on serialization failures and deadlocks; after-commit effects.
5. `scripts/race-test.ts`.
6. [ADR 0002](adr/0002-holds-are-bookings.md), [ADR 0003](adr/0003-seat-locking.md).

**Try:**

- `npm run race`. Watch `naive` sell one seat many times, and the others sell it once.
- Remove `.skipLocked()` from the pessimistic strategy and rerun: still correct, but look at the timings. Why?
- Set `HOLD_TTL_SECONDS=60`, hold a seat, wait a minute, and hold it from another account _before_ the expiry job runs (stop the worker). Lazy expiry at work.

**Questions:**

<details><summary>Walk through exactly how "naive" double-books.</summary>

Two transactions both `SELECT` the seat and see `available` (neither has written yet). Both pass the check, both `UPDATE`. The second update overwrites the first, but both requests already returned 201 with different bookings. The bug is the gap between read and write.
</details>

<details><summary>FOR UPDATE vs FOR UPDATE SKIP LOCKED vs optimistic versioning: when would you pick each?</summary>

`FOR UPDATE` queues waiters behind the lock: correct, but under a stampede everyone holds a connection while waiting. `SKIP LOCKED` lets losers fail instantly: ideal when "someone else is taking it" means "you lost". Optimistic versioning takes no locks and detects conflicts at write time: best when conflicts are rare, wasteful when they're the norm.
</details>

<details><summary>"Best available" picks a block, then holds it. What if another buyer takes it in between?</summary>

The hold fails with `SEATS_UNAVAILABLE`, exactly as for any other buyer, so correctness never depends on the pick. `holdBestSeats` then re-reads the seats and tries the next best block, skipping the contested one (its buyer may not have committed yet, so those seats can still look free). Four attempts, then 409: under a rush, failing fast beats looping.
</details>

<details><summary>Why does best available avoid leaving a single empty seat?</summary>

Almost nobody books one seat between strangers, so a stranded seat usually goes unsold: lost revenue, and a gap in the crowd. Within a section the algorithm prefers blocks that leave 0 or 2+ free seats beside them. It never moves you to a worse section to achieve that, because a downgrade costs the buyer more than a lone seat costs the venue. Picking by hand only warns. See `pickBestSeats`.
</details>

<details><summary>How do you prevent deadlocks between holding, paying, cancelling and expiring?</summary>

Every code path locks rows in the same global order: seats (ascending id), then the booking, then the payment. Deadlocks need a cycle, and a single order makes cycles impossible. The transaction helper still retries a deadlock (40P01) if one happens, and maps it to a 503 if retries run out.
</details>

<details><summary>Why is the claim gate safe to skip when Redis is down?</summary>

It only filters out requests that would lose anyway. Postgres makes the actual decision inside the transaction, so without the gate you get more database load, not wrong answers.
</details>

---

## Phase 4: background jobs, tickets, posters

**Teaches:** the dual-write problem, at-least-once delivery, idempotent handlers, retries and dead letters, signed tokens, direct-to-storage uploads.

**Read, in order:**

1. `src/jobs/queues.ts` (the job types), then `src/jobs/outbox.ts` (enqueue + relay).
2. `src/jobs/runner.ts`: retries, backoff, the dead-letter queue, logging with the request id.
3. `src/jobs/handlers/email.ts` (`sendOnce`), `src/lib/mailer.ts` and `src/lib/resend.ts`: email transports, idempotency keys, and which provider errors are worth retrying ([ADR 0012](adr/0012-resend.md)).
4. `src/modules/tickets/signing.ts` and `service.ts`: Ed25519 tickets, one-shot check-in.
5. `src/modules/events/posters.ts` and `src/jobs/handlers/media.ts`: presigned uploads and resizing.
6. `src/worker.ts` and `src/jobs/schedules.ts`.
7. [ADR 0004](adr/0004-transactional-outbox.md).

**Try:**

- Stop the worker, buy a ticket, look at the `outbox` table, start the worker, watch the email arrive (Mailpit: http://localhost:8025). Nothing was lost.
- Make a handler throw, and watch retries with backoff, then the dead letter at `GET /api/v1/admin/dead-letters`.
- Check in the same ticket twice concurrently: exactly one succeeds.

**Questions:**

<details><summary>What goes wrong if the API enqueues the job directly after committing?</summary>

If the process dies (or Redis is unreachable) between the commit and the enqueue, the booking exists but its email and expiry job never do. Enqueue before commit, and a rollback leaves a job for something that never happened. The outbox makes the job part of the same transaction.
</details>

<details><summary>At-least-once delivery means a job can run twice. How does the booking email avoid being sent twice?</summary>

`sendOnce` creates (or finds) the `notifications` row for that message, locks it for the duration of the send, and skips if it's already `sent`. A concurrent duplicate waits on the lock, then sees `sent`. That leaves a crash after the provider accepted the email but before the commit. Over SMTP that gap is unavoidable. With Resend, the send carries an idempotency key (`booking-confirmed/<booking id>`), and Resend won't send the same key twice within 24 hours.
</details>

<details><summary>Which email failures should a job retry, and which should go straight to the dead-letter queue?</summary>

Retry what time can fix: a rate limit (429), a concurrent request with the same key, a provider outage (5xx), a timeout. Dead-letter what it can't: a bad API key, an unverified sending domain, an invalid address, or a used-up quota (it resets hours later, far beyond the job's backoff). Retrying those only delays the moment someone learns what to fix. See `src/lib/resend.ts`.
</details>

<details><summary>Why sign tickets with Ed25519 rather than store a random code?</summary>

A scanner can verify a ticket with the public key alone, offline, and forging one requires the private key. The database still decides admission (one conditional UPDATE per ticket), but a fake QR code is rejected without a lookup.
</details>

---

## Phase 5: payments, webhooks, idempotency

**Teaches:** designing around unreliable messages, idempotency keys, state machines, money invariants.

**Read, in order:**

1. The comment at the top of `src/modules/payments/service.ts`, then `startPayment`, `ingestWebhook`, `processWebhookEvent`, `reconcilePayment`.
2. `src/modules/payments/signature.ts`: HMAC verification (raw body, constant time, timestamp window).
3. `src/lib/idempotency.ts`.
4. `src/modules/bookings/service.ts`: `confirmBookingInTx` (including the late-payment path).
5. `src/fake-gateway/`: a provider you can make misbehave.
6. `src/lib/invariants.ts`: the rules money must obey.
7. [ADR 0005](adr/0005-payments-reconcile.md).

**Try:**

- `FAKE_GATEWAY_CHAOS=true`: every webhook is delivered twice, late and out of order. Buy tickets; bookings still end right. Then `npm run check:invariants`.
- Hold, start paying, let the hold lapse, sell the seat to someone else, then complete the first payment: automatic refund.
- Send the same `POST /events/:id/bookings` twice with the same `Idempotency-Key`.

**Questions:**

<details><summary>Why fetch the payment's state from the provider instead of using the webhook body?</summary>

Webhooks arrive in any order and more than once. Acting on the body means a stale event ("processing") can overwrite a newer state ("succeeded"). Reading the current state makes every run converge to the same result: processing is idempotent and order-independent.
</details>

<details><summary>Why verify the signature over the raw body, not the parsed JSON?</summary>

The signature covers exact bytes. Re-serializing parsed JSON can change whitespace, key order or number formatting, which breaks verification, or worse, tempts you to "normalize" your way into accepting a tampered body.
</details>

<details><summary>What does an Idempotency-Key do that "one open payment per booking" doesn't?</summary>

It makes a retried request return the original response, even if the first attempt's response was lost, so a retried hold can't create a second booking. The key is claimed before running: a concurrent duplicate gets 409 `IDEMPOTENCY_REQUEST_IN_PROGRESS` (retry shortly), and reusing a key with a different body is rejected (422).
</details>

---

## Phase 6: the flash sale

**Teaches:** measuring before optimizing, fan-out, caching strategies, rate limiting, load shedding, cascading failures.

**Read, in order:**

1. `src/realtime/seat-updates.ts` and `src/realtime/hub.ts`: publish after commit, per-replica fan-out, batching, backpressure.
2. `public/app.js`: subscribe first, snapshot second, versions; reconnection with backoff.
3. `src/lib/cache.ts`: `MicroCache` (single-flight) and `readThrough` with generations.
4. `src/lib/rate-limit.ts`: a token bucket in a Lua script.
5. `src/db/index.ts` and `src/lib/errors.ts`: pool limits, timeouts, 503 + Retry-After.
6. `deploy/nginx/local.conf`: `least_conn`, and the comment about `proxy_next_upstream`.
7. `scripts/loadtest/flash-sale.js`, and the load test section of the README.
8. [ADR 0007](adr/0007-live-seat-updates.md), [ADR 0008](adr/0008-caching.md), [ADR 0009](adr/0009-overload.md).

**Try:**

- `scripts/cluster.sh loadtest` (the cluster with the per-IP limit lifted), `npm run loadtest:setup`, then `RATE=300 npm run loadtest`, then `npm run check:invariants`.
- Put `http_503` back into `proxy_next_upstream` in `deploy/nginx/local.conf`, rerun at a high rate, and watch the 502s appear. That's the cascading failure from the README.
- Open the seat map in two windows and kill the API instance one of them is connected to.

**Questions:**

<details><summary>Why publish seat changes after commit, and why do clients need versions?</summary>

Publishing before commit could announce a change that then rolls back. Versions let clients discard updates older than what they already have, so the snapshot/update race, duplicates and reordering can't show a wrong seat.
</details>

<details><summary>Why generation counters instead of deleting cache keys on write?</summary>

A slow reader that loaded old data before the write can store it after the delete, and stale data then lives until its TTL. With generations, the slow reader writes under the old generation, which no one reads any more.
</details>

<details><summary>How did "retry on 503" turn overload into an outage?</summary>

Nginx counted each 503 as a replica failure. Under load every replica shed some requests, so all three crossed `max_fails` and Nginx marked them all down. Everything then got 502 "no live upstreams", including requests the replicas could have served.
</details>

---

## Phase 7: shipping it

**Teaches:** containers, configuration and secrets, health checks, graceful shutdown, observability, CI/CD, zero-downtime deploys.

**Read, in order:**

1. `Dockerfile` (multi-stage, non-root, tini as PID 1) and `docker-compose.yml`.
2. `src/server.ts` and `src/lib/lifecycle.ts`: graceful shutdown; `src/modules/health/`.
3. `src/lib/logger.ts`, `src/lib/metrics.ts`, and the request-id code in `src/app.ts`.
4. `.github/workflows/ci.yml` and `deploy.yml`.
5. `deploy/docker-compose.prod.yml`, `deploy/nginx/templates/ticket-mng.conf.template`, `deploy/rollout.sh`.
6. [DEPLOY.md](DEPLOY.md), [ADR 0010](adr/0010-deployment.md).

**Try:**

- `docker compose up -d --build`, then `docker compose --profile monitoring up -d` and look at Grafana (http://localhost:3030) while running the load test against `:8080`.
- Follow one request everywhere: copy `x-request-id` from a response, then `docker compose logs api worker nginx | grep <id>`.
- Run `k6 run scripts/loadtest/rollout-probe.js &` and then `deploy/rollout.sh`, and compare with `docker compose up -d --force-recreate api` under the same probe.

**Questions:**

<details><summary>Liveness vs readiness: why two endpoints?</summary>

Liveness asks "is the process stuck?"; failing it gets the container restarted, so it must not depend on the database (an outage would restart everything in a loop). Readiness asks "should traffic come here?"; it checks dependencies and turns false during shutdown so load balancers drain the instance first.
</details>

<details><summary>Why does the Dockerfile run the app under tini?</summary>

PID 1 in a container doesn't get default signal handlers, and nobody reaps zombie processes. tini forwards SIGTERM to Node (so graceful shutdown actually runs on `docker stop`) and reaps children.
</details>

<details><summary>Why did "start new replicas, then stop the old ones" still drop requests?</summary>

Nginx learns about container changes through DNS, re-resolved every 2 s. Right after an old replica exits, Nginx can still send it a request; nothing answers at that address, the connection attempt times out, and by then the replica list has changed, which makes Nginx give up on retrying (502). The rollout script pins Nginx to the new replicas before stopping the old ones.
</details>

<details><summary>How do you roll back a release that included a migration?</summary>

You design migrations so you don't have to roll them back: they only add (expand), and removals come a release later (contract). The previous release runs fine on the newer schema, so rolling back is just deploying the previous image.
</details>

---

## Capstone: trace one purchase end to end

With the Docker stack running, buy a ticket through the seat map, then reconstruct the whole story from the evidence alone:

1. The hold: its `x-request-id`, the Nginx log line, the API log line, the `bookings` row, and the outbox row that scheduled its expiry.
2. The payment: the `payments` row, the webhook in `webhook_events`, the `process-webhook` job in the worker's logs (same request id as the webhook request).
3. The confirmation: which transaction flipped the seats to `booked`, issued `tickets`, and queued the email; the `notifications` row; the email in Mailpit; the QR code.
4. The live update: the WebSocket frame the other window received (browser devtools → Network → WS).
5. The metrics that moved: `booking_hold_attempts_total`, `job_duration_seconds`, `http_request_duration_seconds` for the hold route.

If you can explain each step and why it's safe to repeat, you understand the system.

## Glossary

| Term               | Meaning here                                                                         |
| ------------------ | ------------------------------------------------------------------------------------ |
| Hold               | A pending booking that reserves seats for 10 minutes                                 |
| Lazy expiry        | Treating a lapsed hold as free at read time, without waiting for a job               |
| Claim gate         | Redis pre-check that turns away losing booking attempts before they reach Postgres   |
| Outbox             | A table of jobs written in the same transaction as the change that needs them        |
| Idempotent         | Safe to do twice: the second time changes nothing                                    |
| Reconciliation     | Deriving our state from the provider's current state rather than from event contents |
| Generation counter | A number in cache keys, bumped on writes, so old entries are simply never read again |
| Load shedding      | Refusing some work quickly (503, 429, 409) to keep serving the rest                  |
| Drain              | Letting in-flight work finish while accepting no new work, before a process exits    |
