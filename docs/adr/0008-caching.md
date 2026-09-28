# 0008. Two caches: a 1-second micro-cache and generation-keyed Redis

**Status:** accepted

## Context

A flash sale concentrates reads on one event: its page, its seat map, its availability count. Those reads must not compete with the holds for database connections. But the data differs: the seat map changes constantly, and the event page and listings rarely.

## Decision

- **Hot, fast-changing data** (seat maps, availability): an in-process **micro-cache** with a 1-second TTL and **single-flight**: when a thousand requests miss at once, one runs the query and the rest wait for its result. Responses carry an ETag, so unchanged maps cost a 304. Never invalidated: one second of staleness is fine because the WebSocket delivers every change.
- **Read-mostly data** (event detail, public listings): a **Redis read-through cache keyed by generation counters**. Writes bump the generation of what they touched, after commit. Readers build keys from the current generation.

Why generations instead of deleting keys: with delete-on-write, a slow reader that loaded old data before the write can store it _after_ the delete, and the stale entry lives until its TTL. With generations, that slow reader can only store stale data under the old generation, which nobody reads any more.

## Consequences

- Seat-map load no longer scales with the audience: it's bounded by one query per second per replica.
- Correct invalidation without distributed locks.
- Old generations linger until their TTL (memory, not correctness).
- The cache is never the source of truth for decisions: holds always check seats in Postgres.

## Alternatives considered

- **Caching seat maps in Redis with invalidation on every change:** more Redis traffic than just re-querying once per second.
- **HTTP caching via a CDN:** would work for the public pages; not needed at this scale, and the ETag/304 support makes it easy to add later.
