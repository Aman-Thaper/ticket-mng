# 0007. Live seat maps over WebSockets, fanned out with Redis pub/sub

**Status:** accepted

## Context

During an on-sale, thousands of people watch the same seat map, and seats change every second. Polling would multiply load by the audience size and still show stale seats. Viewers are spread across API replicas, but a seat change happens on whichever replica served that request.

## Decision

- Every seat mutation returns the changed rows (`RETURNING id, status, version`), and they are **published after commit** to the Redis channel `seats:<event>`. Rolled-back changes are never announced.
- Each replica runs a hub that subscribes only to events its own viewers watch, batches changes for 100 ms (newest version per seat wins), and sends one message per batch to each viewer.
- Clients **subscribe first, then load the snapshot**, and apply a change only if its version is newer than the one they have. Nothing is missed in between, and duplicates or reordering are harmless.
- Protection: clients more than 1 MiB behind are dropped, heartbeats every 30 s clear dead connections, a per-replica connection cap (20,000), and code 1013 ("try again later") when full. On shutdown, code 1001 tells clients to reconnect, with exponential backoff and jitter.

## Consequences

- One database write fans out to any number of viewers at the cost of one Redis publish.
- Pub/sub is fire-and-forget: a replica that misses messages (a Redis blip) could show stale seats. The version scheme plus the 1-second snapshot cache bound the damage, and a reconnect reloads the snapshot.
- WebSocket connections are long-lived, which matters for deploys (hence close code 1001 plus reconnect) and for Nginx's file-descriptor limits.

## Alternatives considered

- **Polling:** simple, but load grows with viewers × frequency.
- **Server-Sent Events:** would work (updates only flow one way); WebSockets were chosen for tooling and to leave room for client messages.
- **Redis Streams:** replayable, but viewers only need the latest state, which the snapshot plus versions already give.
