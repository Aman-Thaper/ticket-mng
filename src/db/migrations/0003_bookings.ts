import { sql, type Kysely } from 'kysely';

// Bookings and seat holds.
//
// A hold IS a booking in status 'pending' with an expires_at deadline, not a separate
// concept. The seat rows point at the booking that holds them. Everything that decides
// who gets a seat happens on those seat rows, under row locks, inside Postgres.
//
// Global lock order, used by every code path: seat rows (ascending id), then booking rows.
// With one order there can be no lock cycles, and so no deadlocks between booking, paying,
// cancelling and expiring.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- NULL = on sale as soon as the event is published. Sales always close at starts_at.
    ALTER TABLE events ADD COLUMN sales_start_at timestamptz;
    ALTER TABLE events ADD COLUMN max_tickets_per_user integer NOT NULL DEFAULT 10
      CHECK (max_tickets_per_user BETWEEN 1 AND 50);
    ALTER TABLE events ADD CONSTRAINT events_sales_start_before_event CHECK (sales_start_at < starts_at);

    CREATE TYPE booking_status AS ENUM ('pending', 'confirmed', 'expired', 'cancelled', 'refunded');

    CREATE TABLE bookings (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
      event_id     uuid NOT NULL REFERENCES events (id) ON DELETE RESTRICT,
      status       booking_status NOT NULL DEFAULT 'pending',
      total_cents  integer NOT NULL CHECK (total_cents >= 0),
      currency     char(3) NOT NULL,
      expires_at   timestamptz NOT NULL,   -- end of the seat hold; only meaningful while pending
      confirmed_at timestamptz,
      expired_at   timestamptz,
      cancelled_at timestamptz,
      refunded_at  timestamptz,
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now()
    );
    CREATE TRIGGER bookings_updated_at BEFORE UPDATE ON bookings
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- At most one active hold per user per event. It stops seat hoarding (one user
    -- can't grab 50 separate holds), and it makes the per-user ticket limit race-free:
    -- two concurrent holds from the same user can't both commit.
    CREATE UNIQUE INDEX bookings_one_pending_per_user_event ON bookings (user_id, event_id)
      WHERE status = 'pending';
    CREATE INDEX bookings_user_idx ON bookings (user_id, created_at DESC);
    CREATE INDEX bookings_event_idx ON bookings (event_id, status);
    -- For the sweeper that releases expired holds. Partial index: only pending rows are in
    -- it, so it stays tiny however many bookings accumulate.
    CREATE INDEX bookings_pending_expiry_idx ON bookings (expires_at) WHERE status = 'pending';

    -- The seats of a booking, with the price as it was at booking time.
    CREATE TABLE booking_items (
      booking_id    uuid NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
      event_seat_id bigint NOT NULL REFERENCES event_seats (id) ON DELETE RESTRICT,
      price_cents   integer NOT NULL CHECK (price_cents >= 0),
      PRIMARY KEY (booking_id, event_seat_id)
    );
    CREATE INDEX booking_items_seat_idx ON booking_items (event_seat_id);

    -- Current holder of each seat, and a version counter bumped on every change (used by the
    -- optimistic-locking strategy and by clients to order live seat updates).
    -- RESTRICT: a booking that still holds seats can't be deleted (bookings are financial
    -- records, and SET NULL would leave a 'held' seat with no holder).
    ALTER TABLE event_seats ADD COLUMN booking_id uuid REFERENCES bookings (id) ON DELETE RESTRICT;
    ALTER TABLE event_seats ADD COLUMN version integer NOT NULL DEFAULT 0;
    CREATE INDEX event_seats_booking_idx ON event_seats (booking_id) WHERE booking_id IS NOT NULL;

    -- Before this migration, the seed script marked random seats 'booked' with no booking
    -- behind them. Those flags meant nothing, so release them before adding the invariant.
    UPDATE event_seats SET status = 'available' WHERE status <> 'available';

    -- Invariant: a seat is available exactly when no booking holds it.
    ALTER TABLE event_seats ADD CONSTRAINT event_seats_holder_matches_status
      CHECK ((status = 'available') = (booking_id IS NULL));
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE event_seats DROP CONSTRAINT IF EXISTS event_seats_holder_matches_status;
    ALTER TABLE event_seats DROP COLUMN IF EXISTS version;
    ALTER TABLE event_seats DROP COLUMN IF EXISTS booking_id;
    DROP TABLE IF EXISTS booking_items, bookings;
    DROP TYPE IF EXISTS booking_status;
    ALTER TABLE events DROP CONSTRAINT IF EXISTS events_sales_start_before_event;
    ALTER TABLE events DROP COLUMN IF EXISTS max_tickets_per_user;
    ALTER TABLE events DROP COLUMN IF EXISTS sales_start_at;
  `.execute(db);
}
