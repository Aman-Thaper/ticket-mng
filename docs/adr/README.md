# Architecture decision records

Short notes on the decisions that shaped this system: the problem, what was chosen, what it costs, and what else was considered. When you change one of these decisions, add a new record that supersedes the old one rather than rewriting history.

| #                                        | Decision                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| [0001](0001-stack.md)                    | Fastify, Zod and Kysely on PostgreSQL; no ORM, no backend-as-a-service      |
| [0002](0002-holds-are-bookings.md)       | A seat hold is a pending booking, and it expires lazily                     |
| [0003](0003-seat-locking.md)             | `SELECT … FOR UPDATE SKIP LOCKED`, behind a Redis claim gate                |
| [0004](0004-transactional-outbox.md)     | Background jobs go through a transactional outbox                           |
| [0005](0005-payments-reconcile.md)       | Webhooks are hints: reconcile from the provider's current state             |
| [0006](0006-auth-tokens-and-sessions.md) | Short-lived access tokens, rotating refresh tokens, server-side sessions    |
| [0007](0007-live-seat-updates.md)        | Live seat maps over WebSockets, fanned out with Redis pub/sub               |
| [0008](0008-caching.md)                  | Two caches: a 1-second micro-cache and generation-keyed Redis               |
| [0009](0009-overload.md)                 | Under overload, fail fast and shed load; never queue                        |
| [0010](0010-deployment.md)               | One VPS with Docker Compose, and a rollout script for zero-downtime deploys |
| [0011](0011-email-verification.md)       | Booking requires a confirmed email address, since tickets are emailed       |
| [0012](0012-resend.md)                   | Email through Resend's HTTP API, with idempotency keys and pacing           |

Template:

```markdown
# NNNN. Title

**Status:** accepted | superseded by NNNN

## Context

What problem, what constraints, what forces.

## Decision

What we do.

## Consequences

What gets better, what gets worse, what we now have to live with.

## Alternatives considered

What else, and why not.
```
