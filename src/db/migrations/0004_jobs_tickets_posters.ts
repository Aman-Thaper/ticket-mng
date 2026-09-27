import { sql, type Kysely } from 'kysely';

// Background work: the transactional outbox, a notification log, tickets and posters.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ---------------------------------------------------------------- transactional outbox
    -- The API never talks to the job queue directly. It inserts a row here in the SAME
    -- transaction as the business change (e.g. "booking confirmed"). A relay in the worker
    -- moves committed rows into BullMQ. So:
    --   * rollback  -> no row -> no email for a booking that never happened;
    --   * commit    -> the row exists -> the job WILL be published, even if Redis is down
    --                  or the process crashes right after commit.
    CREATE TABLE outbox (
      id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      queue        text NOT NULL,
      job_name     text NOT NULL,
      payload      jsonb NOT NULL DEFAULT '{}',
      job_id       text,                               -- BullMQ id: publishing twice is a no-op
      run_at       timestamptz NOT NULL DEFAULT now(), -- delayed jobs run at this time
      request_id   text,                               -- the HTTP request that caused it (log correlation)
      created_at   timestamptz NOT NULL DEFAULT now(),
      published_at timestamptz
    );
    CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;

    -- Wake the relay the moment new rows commit. NOTIFY is transactional: it's delivered on
    -- commit and never for rolled-back work. The relay also polls, in case a notification
    -- is missed while it's reconnecting.
    CREATE FUNCTION notify_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_notify('outbox', '');
      RETURN NULL;
    END $$;
    CREATE TRIGGER outbox_notify AFTER INSERT ON outbox
      FOR EACH STATEMENT EXECUTE FUNCTION notify_outbox();

    ---------------------------------------------------------------- notification log
    -- Jobs are delivered at least once, so a retried email job must not send twice. Each
    -- email has a natural key (kind + booking id, ...). It's recorded as 'sending' before the
    -- SMTP call and 'sent' after. A retry skips 'sent'. Only a crash mid-send can produce a
    -- duplicate, the unavoidable edge of at-least-once delivery.
    CREATE TABLE notifications (
      kind       text NOT NULL,
      ref_id     text NOT NULL,
      user_id    uuid REFERENCES users (id) ON DELETE CASCADE,
      status     text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent')),
      created_at timestamptz NOT NULL DEFAULT now(),
      sent_at    timestamptz,
      PRIMARY KEY (kind, ref_id)
    );

    ---------------------------------------------------------------- tickets
    CREATE TYPE ticket_status AS ENUM ('valid', 'void');
    CREATE TABLE tickets (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id    uuid NOT NULL REFERENCES bookings (id) ON DELETE RESTRICT,
      event_id      uuid NOT NULL REFERENCES events (id) ON DELETE RESTRICT,
      event_seat_id bigint NOT NULL REFERENCES event_seats (id) ON DELETE RESTRICT,
      status        ticket_status NOT NULL DEFAULT 'valid',
      checked_in_at timestamptz,
      checked_in_by uuid REFERENCES users (id),
      voided_at     timestamptz,
      created_at    timestamptz NOT NULL DEFAULT now()
    );
    -- The last line of defence against double selling: whatever any code path does, one
    -- seat can never have two valid tickets.
    CREATE UNIQUE INDEX tickets_one_valid_per_seat ON tickets (event_seat_id) WHERE status = 'valid';
    CREATE INDEX tickets_booking_idx ON tickets (booking_id);
    CREATE INDEX tickets_event_idx ON tickets (event_id);

    -- Backfill: bookings confirmed before tickets existed get theirs now.
    INSERT INTO tickets (booking_id, event_id, event_seat_id, created_at)
    SELECT bi.booking_id, b.event_id, bi.event_seat_id, coalesce(b.confirmed_at, now())
    FROM booking_items bi
    JOIN bookings b ON b.id = bi.booking_id
    WHERE b.status = 'confirmed';

    -- The hold sweeper looks for held seats whose booking is no longer an active hold. Held
    -- seats are a tiny fraction of all seats, so a partial index makes that lookup instant.
    CREATE INDEX event_seats_held_idx ON event_seats (booking_id) WHERE status = 'held';

    ---------------------------------------------------------------- posters
    CREATE TYPE poster_status AS ENUM ('processing', 'ready', 'failed');
    ALTER TABLE events ADD COLUMN poster_status   poster_status;  -- NULL = no poster
    ALTER TABLE events ADD COLUMN poster_key      text;           -- latest original upload (private)
    ALTER TABLE events ADD COLUMN poster_variants jsonb;          -- {"320": "<object key>", ...}
    ALTER TABLE events ADD COLUMN poster_error    text;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE events DROP COLUMN IF EXISTS poster_error;
    ALTER TABLE events DROP COLUMN IF EXISTS poster_variants;
    ALTER TABLE events DROP COLUMN IF EXISTS poster_key;
    ALTER TABLE events DROP COLUMN IF EXISTS poster_status;
    DROP TYPE IF EXISTS poster_status;
    DROP INDEX IF EXISTS event_seats_held_idx;
    DROP TABLE IF EXISTS tickets, notifications, outbox;
    DROP TYPE IF EXISTS ticket_status;
    DROP FUNCTION IF EXISTS notify_outbox();
  `.execute(db);
}
