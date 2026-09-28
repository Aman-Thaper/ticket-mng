# 0005. Webhooks are hints: reconcile from the provider's current state

**Status:** accepted

## Context

Payment providers report outcomes through webhooks, and webhooks are delivered at least once, possibly out of order ("succeeded" before "processing"), possibly late (after the hold lapsed), and possibly forged by anyone who finds the URL. Clients retry requests after timeouts, so "pay" can arrive twice.

## Decision

- **Verify, then store, then acknowledge.** HMAC-SHA256 over the raw body with a constant-time comparison and a 5-minute timestamp window (secret rotation supported). The event is inserted into `webhook_events` (primary key: provider + event id, so duplicates are acknowledged and ignored) together with an outbox job, and the provider gets a 200 at once.
- **Reconcile.** The job ignores the event's payload and asks the provider for the payment's current state, then moves our records towards it. Every delivery, in any order and any number of times, converges on the same result.
- **Record and confirm in one transaction**, locking seats, then the booking, then the payment (the global lock order). If the booking can't be confirmed any more (seats sold after the hold lapsed, event cancelled, already paid by another payment), the same transaction records the money and creates a refund.
- **Idempotency everywhere money moves:** one open payment per booking; provider calls carry idempotency keys; clients can send `Idempotency-Key` (the key is claimed before executing, a repeat replays the stored response, reuse with a different body is a 422, and a crashed attempt's claim is taken over after 60 s).
- **A fake, Stripe-shaped provider** (signed webhooks, test cards, a chaos mode that duplicates and reorders deliveries) makes the whole flow testable offline; Stripe is a configuration switch.

## Consequences

- Duplicate, late and reordered webhooks are normal cases with tests, not incidents.
- Each webhook costs one provider API call. Fine at this scale; batch or cache if it ever isn't.
- Refunds are asynchronous: seats and tickets are released only once the provider confirms.

## Alternatives considered

- **Trust the webhook payload:** order-dependent and replay-sensitive; a stale "processing" can overwrite a "succeeded".
- **Synchronous confirmation on the client's redirect:** the client can vanish mid-flow; the webhook is the reliable signal.
