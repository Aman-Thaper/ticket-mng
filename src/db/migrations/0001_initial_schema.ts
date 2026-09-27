import { sql, type Kysely } from 'kysely';

// Migrations are plain SQL on purpose. Reading and writing the DDL yourself is part of the exercise.
// Never edit a migration that has already run anywhere; add a new one instead.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE EXTENSION IF NOT EXISTS citext;      -- case-insensitive text for emails
    CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- trigram indexes for ILIKE '%foo%'
    CREATE EXTENSION IF NOT EXISTS btree_gist;  -- lets the venue-overlap EXCLUDE constraint mix = and &&

    -- Keeps updated_at correct no matter which code path updates the row.
    CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      NEW.updated_at := now();
      RETURN NEW;
    END $$;

    CREATE TYPE user_role      AS ENUM ('attendee', 'organizer', 'admin');
    CREATE TYPE event_status   AS ENUM ('draft', 'published', 'cancelled');
    CREATE TYPE event_category AS ENUM ('concert', 'theatre', 'comedy', 'sports', 'festival', 'other');
    CREATE TYPE seat_status    AS ENUM ('available', 'held', 'booked');

    ---------------------------------------------------------------- users
    CREATE TABLE users (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email      citext NOT NULL UNIQUE,
      name       text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
      role       user_role NOT NULL DEFAULT 'attendee',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    ---------------------------------------------------------------- venues + physical seat layout
    CREATE TABLE venues (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name       text NOT NULL,
      address    text NOT NULL,
      city       text NOT NULL,
      country    char(2) NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
      capacity   integer NOT NULL CHECK (capacity > 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX venues_city_idx ON venues (lower(city));
    CREATE INDEX venues_name_trgm_idx ON venues USING gin (name gin_trgm_ops);
    CREATE TRIGGER venues_updated_at BEFORE UPDATE ON venues
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE venue_sections (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      venue_id   uuid NOT NULL REFERENCES venues (id) ON DELETE CASCADE,
      name       text NOT NULL,
      sort_order integer NOT NULL,
      UNIQUE (venue_id, name)
    );

    CREATE TABLE venue_seats (
      id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      section_id  uuid NOT NULL REFERENCES venue_sections (id) ON DELETE CASCADE,
      row_label   text NOT NULL,
      seat_number integer NOT NULL CHECK (seat_number > 0),
      x           integer NOT NULL,  -- grid position, used to draw the seat map
      y           integer NOT NULL,
      UNIQUE (section_id, row_label, seat_number)
    );

    ---------------------------------------------------------------- events
    CREATE TABLE events (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organizer_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
      venue_id     uuid NOT NULL REFERENCES venues (id) ON DELETE RESTRICT,
      title        text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
      description  text NOT NULL DEFAULT '',
      category     event_category NOT NULL,
      status       event_status NOT NULL DEFAULT 'draft',
      starts_at    timestamptz NOT NULL,
      ends_at      timestamptz NOT NULL,
      currency     char(3) NOT NULL DEFAULT 'USD',
      search       tsvector GENERATED ALWAYS AS (
                     setweight(to_tsvector('english', title), 'A') ||
                     setweight(to_tsvector('english', description), 'B')
                   ) STORED,
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now(),
      CHECK (ends_at > starts_at),

      -- The database, not the application, guarantees that two live events never
      -- overlap in time at the same venue. That holds even under concurrent inserts.
      CONSTRAINT events_no_venue_overlap EXCLUDE USING gist (
        venue_id WITH =,
        tstzrange(starts_at, ends_at) WITH &&
      ) WHERE (status <> 'cancelled')
    );
    -- Postgres does NOT index foreign keys automatically.
    CREATE INDEX events_organizer_idx ON events (organizer_id);
    -- Serves the main listing: WHERE status = ? ORDER BY starts_at, id (keyset pagination).
    CREATE INDEX events_listing_idx ON events (status, starts_at, id);
    CREATE INDEX events_search_idx ON events USING gin (search);
    CREATE TRIGGER events_updated_at BEFORE UPDATE ON events
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    ---------------------------------------------------------------- per-event seat inventory
    -- One row per sellable seat per event. The venue layout is a template and this is the stock.
    CREATE TABLE event_seats (
      id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      event_id      uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
      venue_seat_id bigint NOT NULL REFERENCES venue_seats (id) ON DELETE RESTRICT,
      price_cents   integer NOT NULL CHECK (price_cents >= 0),
      status        seat_status NOT NULL DEFAULT 'available',
      UNIQUE (event_id, venue_seat_id)  -- this index also serves "all seats for event X"
    );
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE IF EXISTS event_seats, events, venue_seats, venue_sections, venues, users;
    DROP TYPE IF EXISTS seat_status, event_category, event_status, user_role;
    DROP FUNCTION IF EXISTS set_updated_at();
  `.execute(db);
}
