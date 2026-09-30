# 0012. Email through Resend's HTTP API

**Status:** accepted

## Context

Tickets, confirmation links and password resets are delivered by email, so sending has to be reliable in two directions: every email must go out, and none may go out twice. A buyer who gets their tickets twice wonders whether they paid twice. The jobs that send email are at-least-once (ADR 0004). `sendOnce` records each email in `notifications`, but a crash after the provider accepted the email and before that record commits still sends it again on retry. Over SMTP that gap can't be closed.

## Decision

- **Resend's HTTP API** (`POST /emails`), called with `fetch` from a small client (`src/lib/resend.ts`) rather than the SDK, behind the same `sendMail` interface as SMTP (Mailpit locally) and the in-memory transport (tests). `MAIL_TRANSPORT` picks one.
- **Idempotency keys** (`<kind>/<ref id>`, e.g. `booking-confirmed/<booking id>`) on every `sendOnce` email: Resend sends a key once in 24 hours, which closes the crash window. A reused key with a changed body (`409 invalid_idempotent_request`) means "already sent", not an error. Account emails (confirmation, reset) mint a new token per attempt, so they don't use keys: a rare duplicate is harmless there.
- **Errors classified by what retrying can achieve:** 429 rate limits, concurrent requests with the same key, 5xx and timeouts are retried with backoff. A bad key, an unverified domain, invalid input and exhausted quotas are `UnrecoverableError`s: dead-lettered at once, with Resend's message, for an admin to retry after fixing the cause.
- **Pacing:** BullMQ's queue limiter caps email at 2 per second across all workers (Resend's default limit), so a sold-out on-sale doesn't burn retries on 429s.
- **Traceability:** Resend's email id is stored in `notifications.provider_message_id`, and each email is tagged with its category.

## Consequences

- Effectively-once ticket emails, even across crashes and timeouts.
- Misconfiguration surfaces quickly and clearly (dead letters naming the problem) instead of as five slow retries.
- A dependency on one provider's API. The transport interface keeps SMTP as a drop-in fallback, and switching providers is one small client.
- Throughput is capped by the provider's limit: 2 emails/s is 7,200 an hour, enough for a 2,000-seat on-sale. Bigger sales need a raised limit (`MAIL_RATE_PER_SECOND`) or batch sending.

## Alternatives considered

- **Resend over SMTP:** works with no code, but loses idempotency keys and precise errors.
- **Resend's SDK:** fine, but the API is one endpoint; a 100-line client shows exactly what goes over the wire.
- **Amazon SES, Postmark, Mailgun:** comparable; Resend was chosen for its API ergonomics, idempotency keys and inline-image support.
