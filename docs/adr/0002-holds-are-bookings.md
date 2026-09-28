# 0002. A seat hold is a pending booking, and it expires lazily

**Status:** accepted

## Context

Buyers get 10 minutes to pay for seats they picked. During that time nobody else may take them; afterwards the seats must be free again, promptly and reliably, even if a background job is late, a worker is down, or two API instances disagree about the time.

## Decision

- A hold **is** a booking with `status = 'pending'` and an `expires_at`. Taking a seat means pointing `event_seats.booking_id` at the booking and setting the seat's status to `held`; paying turns it into `booked`. There is no separate "holds" table to keep consistent with bookings.
- **Lazy expiry.** A seat whose booking is pending but past `expires_at` counts as available immediately (`acquirableSql` in `src/modules/bookings/service.ts`). The check runs in SQL with `now()`, so every instance uses the database's clock.
- An expiry job, scheduled through the outbox for the deadline, and a 30-second sweep release lapsed seats and tell live clients. They only tidy up; correctness never waits for them.
- One pending hold per user per event (partial unique index). A double-click or a second tab can't hoard seats, and the per-user ticket limit becomes race-free.

## Consequences

- Correctness doesn't depend on a timer: a lapsed hold is free even if every worker is down.
- Every read of availability must use the same definition (`acquirableSql`). The seat map, the hold, and the payment confirmation all do.
- A late payment for a lapsed hold is an expected case, not an error: the seats are re-taken if still free, otherwise the payment is refunded (see 0005).

## Alternatives considered

- **Redis keys with a TTL as the hold:** fast, but a hold would then live outside the transaction that sells the seat; a Redis failover could drop holds or double them.
- **Eager expiry only (a cron flips holds to expired):** a late or crashed job keeps seats locked; clocks between instances disagree.
