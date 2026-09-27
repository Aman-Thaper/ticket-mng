import { sql, type Kysely } from 'kysely';

// Payments, refunds, webhooks and idempotency keys.
//
// Booking lifecycle (bookings.status):
//   pending ──pay──▶ confirmed ──refund──▶ refunded
//      │                  │
//      ├─ hold lapses ──▶ expired      (a payment arriving later re-takes the seats if
//      └─ buyer quits ──▶ cancelled     they're still free, or is refunded if not)
//
// Payment lifecycle (payments.status) mirrors the provider's payment intent:
//   requires_payment ─▶ processing ─▶ succeeded ─▶ refunded
//          └──────────────────────────▶ canceled
// A declined card leaves it in requires_payment (with last_error) so the buyer can retry.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TYPE payment_status AS ENUM ('requires_payment', 'processing', 'succeeded', 'canceled', 'refunded');

    CREATE TABLE payments (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id          uuid NOT NULL REFERENCES bookings (id) ON DELETE RESTRICT,
      provider            text NOT NULL,
      provider_payment_id text,             -- set once the provider has created the intent
      client_secret       text,             -- handed to the browser to confirm the payment
      amount_cents        integer NOT NULL CHECK (amount_cents > 0),
      currency            char(3) NOT NULL,
      status              payment_status NOT NULL DEFAULT 'requires_payment',
      last_error          text,
      succeeded_at        timestamptz,
      refunded_at         timestamptz,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      UNIQUE (provider, provider_payment_id)
    );
    CREATE TRIGGER payments_updated_at BEFORE UPDATE ON payments
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    -- One payment attempt in flight per booking: a double-clicked "Pay" can't open two.
    CREATE UNIQUE INDEX payments_one_open_per_booking ON payments (booking_id)
      WHERE status IN ('requires_payment', 'processing');
    CREATE INDEX payments_booking_idx ON payments (booking_id);

    CREATE TYPE refund_status AS ENUM ('pending', 'succeeded', 'failed');

    CREATE TABLE refunds (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      payment_id         uuid NOT NULL REFERENCES payments (id) ON DELETE RESTRICT,
      provider_refund_id text,
      amount_cents       integer NOT NULL CHECK (amount_cents > 0),
      reason             text NOT NULL CHECK (reason IN
                           ('requested_by_customer', 'event_cancelled', 'hold_expired', 'duplicate_payment')),
      status             refund_status NOT NULL DEFAULT 'pending',
      last_error         text,
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now(),
      completed_at       timestamptz
    );
    CREATE TRIGGER refunds_updated_at BEFORE UPDATE ON refunds
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    -- Refunds are full refunds, so a payment can be refunded at most once. This index makes
    -- a second refund impossible even if two code paths race to issue one.
    CREATE UNIQUE INDEX refunds_one_per_payment ON refunds (payment_id) WHERE status <> 'failed';

    -- Every webhook we accepted, keyed by the provider's event id. Providers deliver at least
    -- once, so the same event can arrive several times; the primary key makes the second
    -- copy a no-op.
    CREATE TABLE webhook_events (
      provider            text NOT NULL,
      event_id            text NOT NULL,
      type                text NOT NULL,
      provider_payment_id text,
      payload             jsonb NOT NULL,
      received_at         timestamptz NOT NULL DEFAULT now(),
      processed_at        timestamptz,
      PRIMARY KEY (provider, event_id)
    );

    -- Idempotency-Key header: a retried POST (timeout, flaky mobile network) gets the original
    -- response instead of doing the work twice. Scoped per user; kept for 24 hours.
    -- response_status is NULL while the first request is still running.
    CREATE TABLE idempotency_keys (
      user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      key             text NOT NULL,
      request_hash    text NOT NULL,
      response_status integer,
      response_body   jsonb,
      created_at      timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, key)
    );
    CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE IF EXISTS idempotency_keys, webhook_events, refunds, payments;
    DROP TYPE IF EXISTS refund_status, payment_status;
  `.execute(db);
}
