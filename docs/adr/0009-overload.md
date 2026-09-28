# 0009. Under overload, fail fast and shed load; never queue

**Status:** accepted

## Context

A flash sale sends more requests than the database can serve. A system that queues everything goes from slow to dead: requests wait for connections, clients time out and retry, and the retries add more load. The first 1,000 buyers/second load test showed a worse failure: the protection in one layer turned into an outage in another.

## Decision

- **Bounded waiting.** The API gets a connection from its pool within 5 s or answers **503 + `Retry-After`** (`SERVICE_BUSY`). Postgres kills statements after 15 s and abandoned transactions after 30 s.
- **Cheap rejections first.** Rate limits (a Redis token bucket per client IP for the whole API, per user for holds, per account for logins; 429 + `Retry-After`) and the seat claim gate reject work before it takes a database connection.
- **The proxy must not amplify.** Nginx retries only when a replica can't be reached (`proxy_next_upstream error timeout`), never on 503. In the first 1,000/s run, `http_503` in that list made Nginx count deliberate load shedding as replica failures; after `max_fails` it marked all three replicas dead and answered everything with 502 for seconds at a time: 3,746 errors.
- **Retries need idempotency.** Clients retry holds with an `Idempotency-Key`, so a response lost in the chaos returns the original booking instead of creating a second one.
- **Pool arithmetic:** replicas × `DB_POOL_MAX` + worker + headroom must stay below Postgres' `max_connections`.

## Consequences

- At 1,000 buyers/s on a laptop: 0 errors, p95 of 1.4 s for holds; latency rises, nothing fails, and the invariant check finds no double sale.
- Clients must handle 409, 429 and 503 as normal outcomes; the seat-map page does.
- Limits need tuning per deployment (and load tests from one IP need the per-IP limit lifted).

## Alternatives considered

- **Bigger pools:** more connections make Postgres slower under contention, not faster.
- **Unbounded queues:** turn a spike into minutes of timeouts.
- **A waiting room** (admit buyers at a controlled rate) is the next step for much larger on-sales.
