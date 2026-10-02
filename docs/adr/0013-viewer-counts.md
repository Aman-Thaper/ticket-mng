# 0013. "N viewing now": per-replica counts in a Redis hash, each field expiring on its own

**Status:** accepted

## Context

Event pages show "1,240 viewing now · 86 sold in the last hour", and the catalog opens with "Trending now": the events most people are looking at. A viewer is an open live seat-map WebSocket. Those are spread across API replicas, and each replica knows only its own.

The count has to:

- add up across replicas, and be readable by any replica, for one event (an event page) or many (trending);
- survive a replica crashing, without drifting;
- cost nothing extra during an on-sale, when tens of thousands of people connect within a minute.

## Decision

- **Report, don't increment.** Every 5 s each replica writes its own count per event: `HSETEX viewers:<event> PX 15000 FIELDS 1 <replica> <n>` (Redis 8 sets the field and its own expiry in one atomic command), plus `ZADD live-events <now> <event>`, all in one pipeline.
- **Read by summing.** An event's viewers are the sum of its hash's values (`HVALS`); many events are summed in one pipeline. Trending reads the events touched in the last 15 s from `live-events`, sums them, sorts them, and fills in the cards from Postgres.
- **Clean up without coordination.** When a replica's last viewer of an event leaves, it deletes its field at the next report. On graceful shutdown it deletes all its fields. After a crash, nobody does anything: its fields stop being refreshed and expire within 15 s.
- **Push to clients on change.** After each report the hub reads the totals for its events and sends `{type:'viewers', count}` to an event's sockets only when the total changed. A newcomer gets the last count right after `hello`.
- **"Sold in the last hour" comes from Postgres**: seats in bookings confirmed within the hour, behind a partial index on `(event_id, confirmed_at) WHERE status = 'confirmed'`. The open page then adds every seat it sees turn sold over the WebSocket, so it moves the moment a sale happens.

## Consequences

- Redis work per replica is proportional to the number of events being watched, per 5 s, whatever the audience does. 50,000 joins in a minute cost the same as a quiet afternoon, and the hot path (connecting) touches nothing new.
- Counts lag reality by up to one report (~5 s), and a crashed replica's viewers linger for up to 15 s. That's fine for a social-proof number; nobody's money depends on it.
- During a rolling deploy, a draining replica withdraws its counts at once, and its clients count again on their new replica at its next report: the number dips for a few seconds.
- Without Redis the count is unknown: the API says `viewers: null` and trending is empty. Pages keep working.
- Needs Redis 8 for `HSETEX` (7.4's `HEXPIRE` would do the same in two commands).

## Alternatives considered

- **`INCR` on connect, `DECR` on disconnect:** exact and instant, but a replica that crashes never sends its `DECR`s, so the count drifts upward for good. Repairing it needs per-replica bookkeeping, which is this design. It also puts a Redis write on every connect and disconnect, the hot path of an on-sale.
- **A key per replica per event with `EXPIRE`** (`viewers:<event>:<replica>`): the same idea, but reading one event then needs `SCAN` or a separate index of replicas. A hash keeps an event's counts in one key, read with one command; per-field expiry is what makes it work.
- **A set of connection ids** (`SADD`/`SREM`, then `SCARD`): exact per connection, but memory grows with the audience, and it has the same crash problem as `INCR`/`DECR`.
- **HyperLogLog:** estimates distinct visitors over a period, not people here now.
- **Counting in Postgres:** a write per connection into the database the system protects during on-sales. No.
