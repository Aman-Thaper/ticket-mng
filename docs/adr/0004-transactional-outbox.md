# 0004. Background jobs go through a transactional outbox

**Status:** accepted

## Context

Confirming a booking must send an email with tickets; placing a hold must schedule its expiry; a webhook must be processed. The database change and the job enqueue happen in two different systems (Postgres and Redis). Done naively, a crash between them either sends an email for a booking that rolled back, or never sends the email for one that committed.

## Decision

- Code never enqueues directly. It calls `enqueue(trx, …)`, which inserts an `outbox` row **in the same transaction** as the business change. Both commit or neither does.
- A relay in the worker publishes outbox rows to BullMQ. It wakes on `LISTEN/NOTIFY` (only for jobs due now; see below) and polls as a fallback, claims rows with `FOR UPDATE SKIP LOCKED` so several relays can run, and publishes with a **fixed job id**, so publishing the same row twice is a no-op.
- Handlers are idempotent: emails go through `sendOnce` (a `notifications` row per message), state changes re-check state under locks.
- Retries: 5 attempts, exponential backoff with jitter. Exhausted or unrecoverable jobs go to a dead-letter queue that admins can inspect, retry or discard.
- The request id travels with the outbox row, so a job's logs point back to the request that caused it.

## Consequences

- At-least-once delivery with effectively-once effects.
- A small delay between commit and job start (milliseconds with NOTIFY).
- The outbox needs cleaning (a daily job) and monitoring: `outbox_unpublished{measure="oldest_seconds"}` rising means the relay is stuck.
- Lesson from the load test: a `NOTIFY` on every hold (each schedules its expiry job) serialized commits, because `NOTIFY` takes a global lock at commit time. Migration 0006 notifies only for jobs that are due immediately; delayed ones are found by polling.

## Alternatives considered

- **Enqueue after commit:** loses the job if the process dies between commit and enqueue.
- **Enqueue before commit:** runs jobs for changes that then roll back.
- **Change data capture (Debezium) or logical replication:** robust, but heavy infrastructure for one app.
