# 0003. `SELECT … FOR UPDATE SKIP LOCKED`, behind a Redis claim gate

**Status:** accepted

## Context

"Check the seat is free, then take it" is a race when hundreds of requests do it in the same millisecond. The brief asks for proof: 200 concurrent requests for one seat must produce exactly one owner.

## Decision

Four strategies are implemented behind one interface and measured with `npm run race` (200 simultaneous HTTP requests for one seat):

| Strategy                 | Mechanism                                    | Owners                  | Reached Postgres |
| ------------------------ | -------------------------------------------- | ----------------------- | ---------------- |
| naive                    | read, check, write, no locks                 | **11** (double booking) | 200              |
| optimistic               | `UPDATE … WHERE version = <read version>`    | 1                       | 200              |
| serializable             | `SERIALIZABLE` transaction, retried on 40001 | 1                       | 200              |
| pessimistic              | `SELECT … FOR UPDATE SKIP LOCKED`            | 1                       | 200              |
| pessimistic + claim gate | Redis `SET NX` on every seat first           | 1                       | **30**           |

The default is **pessimistic with the claim gate**:

- `SKIP LOCKED` makes losers see fewer seats than they asked for and fail at once with 409, instead of queueing on the winner's row lock while holding a pool connection.
- The **claim gate** (a Lua script: claim every seat key or none, 5-second TTL, released only by its owner's token) turns most losers away in Redis, before they take a database connection. It is a load shield, not a lock: TTL locks can expire mid-work or vanish in a failover, so the transaction still decides who wins. If Redis is down, the gate is skipped.
- **One global lock order**: seat rows by ascending id, then bookings, then payments, in every code path (hold, pay, cancel, expire, refund, event cancellation). No cycles, so no deadlocks between them.

## Consequences

- Exactly one winner, proven by a repeatable experiment, and cheap failures for everyone else.
- A buyer can get a 409 for a seat that turns out to be free a moment later (the winner's transaction rolled back). That is the right trade during a rush: the page refreshes the seat map live.
- The strategies stay in the code as teaching material; production refuses `naive` at boot.

## Alternatives considered

- **Optimistic concurrency** is excellent at low contention but, under a stampede, does all the work before discovering the conflict.
- **SERIALIZABLE** is the most general (no lock reasoning at all) but aborts and retries a lot under contention.
- **Plain `FOR UPDATE` without `SKIP LOCKED`** serializes everyone behind the winner, holding connections while they wait.
- **Advisory locks** add a second locking vocabulary with no benefit over row locks here.
