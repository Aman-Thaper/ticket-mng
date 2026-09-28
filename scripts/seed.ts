/**
 * Fills the dev database with realistic volume so slow queries show up:
 *   50k users, 500 venues (~430k physical seats), 200k events, seat inventory (~860k rows)
 *   for the next 1,000 upcoming published events, and ~100k confirmed bookings covering a
 *   third of those seats. Takes about 40 s.
 *
 * WIPES ALL DATA FIRST. Run it with `npm run seed`. Scale with SEED_USERS, SEED_VENUES and
 * SEED_EVENTS_PER_VENUE.
 */
import { faker } from '@faker-js/faker';
import { sql } from 'kysely';
import { config } from '../src/config.js';
import { db } from '../src/db/index.js';
import { EVENT_CATEGORIES, type EventCategory, type EventStatus } from '../src/db/types.js';
import { hashPassword } from '../src/modules/auth/passwords.js';
import { generateSeats } from '../src/modules/venues/layout.js';

const USERS = Number(process.env.SEED_USERS ?? 50_000);
const VENUES = Number(process.env.SEED_VENUES ?? 500);
const EVENTS_PER_VENUE = Number(process.env.SEED_EVENTS_PER_VENUE ?? 400);
const EVENTS_WITH_INVENTORY = 1_000;
const BATCH = 10_000;
const SEED_PASSWORD = 'password123';

if (config.NODE_ENV === 'production') throw new Error('Refusing to seed a production database');

faker.seed(42); // same data on every run
const started = Date.now();
const log = (msg: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${msg}`);

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function title(category: EventCategory): string {
  switch (category) {
    case 'concert':
      return `${faker.music.artist()} Live`;
    case 'festival':
      return `${faker.location.city()} ${faker.music.genre()} Festival`;
    case 'comedy':
      return `${faker.person.fullName()}: ${faker.word.adjective()} and ${faker.word.adjective()}`;
    case 'theatre':
      return `${faker.book.title()}`;
    case 'sports':
      return `${faker.location.city()} vs ${faker.location.city()}`;
    case 'other':
      return faker.company.catchPhrase();
  }
}

try {
  // Every application table (all of them hang off users or venues).
  await sql`TRUNCATE users, venues RESTART IDENTITY CASCADE`.execute(db);
  log('truncated');

  // ---------------------------------------------------------------- users
  // Every seeded account shares one password. Hashing once and reusing the hash keeps the
  // seed fast (argon2 is deliberately slow); real signups get a unique salt each.
  const passwordHash = await hashPassword(SEED_PASSWORD);
  const organizerIds: string[] = [];
  for (const batch of chunks(
    Array.from({ length: USERS }, (_, i) => i),
    BATCH,
  )) {
    const roles = batch.map((i) => (i === 0 ? 'admin' : i % 50 === 0 ? 'organizer' : 'attendee'));
    const rows = await sql<{ id: string; role: string }>`
      INSERT INTO users (email, name, role, password_hash, password_changed_at)
      SELECT *, ${passwordHash}, now() FROM unnest(
        ${batch.map((i) => (i === 0 ? 'admin@example.com' : `user${i}@example.com`))}::text[],
        ${batch.map(() => faker.person.fullName())}::text[],
        ${roles}::user_role[]
      )
      RETURNING id, role
    `.execute(db);
    organizerIds.push(...rows.rows.filter((r) => r.role === 'organizer').map((r) => r.id));
  }
  log(`users: ${USERS} (${organizerIds.length} organizers). Password for all: ${SEED_PASSWORD}`);
  log('  admin@example.com is the admin; user50@example.com, user100@example.com, ... are organizers');

  // ---------------------------------------------------------------- venues + seats
  const venueIds: string[] = [];
  let seatTotal = 0;
  for (let v = 0; v < VENUES; v++) {
    const sectionNames = faker.helpers.arrayElements(
      ['Floor', 'Stalls', 'Lower Tier', 'Upper Tier', 'Balcony', 'Mezzanine', 'VIP', 'Box'],
      { min: 2, max: 5 },
    );
    const sections = sectionNames.map((name) => ({
      name,
      rows: faker.number.int({ min: 5, max: 20 }),
      seatsPerRow: faker.number.int({ min: 10, max: 30 }),
    }));
    const seats = generateSeats(sections);
    seatTotal += seats.length;

    await db.transaction().execute(async (trx) => {
      const venue = await trx
        .insertInto('venues')
        .values({
          name: `${faker.location.city()} ${faker.helpers.arrayElement(['Arena', 'Hall', 'Theatre', 'Stadium', 'Club', 'Amphitheatre'])}`,
          address: faker.location.streetAddress(),
          city: faker.helpers.arrayElement([
            'London',
            'Berlin',
            'New York',
            'Paris',
            'Mumbai',
            'Tokyo',
            'Toronto',
            'Sydney',
            faker.location.city(),
          ]),
          country: faker.location.countryCode('alpha-2'),
          capacity: seats.length,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      venueIds.push(venue.id);

      const inserted = await trx
        .insertInto('venueSections')
        .values(sections.map((s, i) => ({ venueId: venue.id, name: s.name, sortOrder: i })))
        .returning(['id', 'name'])
        .execute();
      const sectionId = new Map(inserted.map((s) => [s.name, s.id]));

      await sql`
        INSERT INTO venue_seats (section_id, row_label, seat_number, x, y)
        SELECT * FROM unnest(
          ${seats.map((s) => sectionId.get(s.section))}::uuid[],
          ${seats.map((s) => s.rowLabel)}::text[],
          ${seats.map((s) => s.seatNumber)}::int[],
          ${seats.map((s) => s.x)}::int[],
          ${seats.map((s) => s.y)}::int[]
        )
      `.execute(trx);
    });
  }
  log(`venues: ${VENUES} (${seatTotal} physical seats)`);

  // ---------------------------------------------------------------- events
  // Each venue gets a back-to-back schedule running from a year ago to about two years out.
  // Walking time forward per venue guarantees the no-overlap constraint is never violated.
  type EventRow = {
    organizerId: string;
    venueId: string;
    title: string;
    description: string;
    category: EventCategory;
    status: EventStatus;
    startsAt: Date;
    endsAt: Date;
  };
  const events: EventRow[] = [];
  const DAY = 86_400_000;
  for (const venueId of venueIds) {
    let t = Date.now() - 365 * DAY + faker.number.int({ min: 0, max: 2 * DAY });
    for (let i = 0; i < EVENTS_PER_VENUE; i++) {
      t += (faker.number.int({ min: 1, max: 4 }) * DAY) / 2;
      const start = new Date(Math.round(t / 1_800_000) * 1_800_000); // snap to :00 / :30
      const hours = faker.number.int({ min: 2, max: 5 });
      const category = faker.helpers.weightedArrayElement(
        EVENT_CATEGORIES.map((c) => ({ value: c, weight: c === 'concert' ? 5 : c === 'other' ? 1 : 2 })),
      );
      events.push({
        organizerId: faker.helpers.arrayElement(organizerIds),
        venueId,
        title: title(category),
        description: faker.lorem.sentences({ min: 1, max: 4 }),
        category,
        status: faker.helpers.weightedArrayElement([
          { value: 'published' as const, weight: 85 },
          { value: 'draft' as const, weight: 10 },
          { value: 'cancelled' as const, weight: 5 },
        ]),
        startsAt: start,
        endsAt: new Date(start.getTime() + hours * 3_600_000),
      });
      t = start.getTime() + hours * 3_600_000;
    }
  }

  for (const batch of chunks(events, BATCH)) {
    await sql`
      INSERT INTO events (organizer_id, venue_id, title, description, category, status, starts_at, ends_at)
      SELECT * FROM unnest(
        ${batch.map((e) => e.organizerId)}::uuid[],
        ${batch.map((e) => e.venueId)}::uuid[],
        ${batch.map((e) => e.title)}::text[],
        ${batch.map((e) => e.description)}::text[],
        ${batch.map((e) => e.category)}::event_category[],
        ${batch.map((e) => e.status)}::event_status[],
        ${batch.map((e) => e.startsAt.toISOString())}::timestamptz[],
        ${batch.map((e) => e.endsAt.toISOString())}::timestamptz[]
      )
    `.execute(db);
  }
  log(`events: ${events.length}`);

  // ---------------------------------------------------------------- seat inventory
  // Inventory only for the soonest upcoming shows. Giving every event its seats would mean
  // roughly 140M rows.
  const inv = await sql`
    INSERT INTO event_seats (event_id, venue_seat_id, price_cents)
    SELECT e.id, vs.id, greatest(1500, 12000 - sec.sort_order * 2500)
    FROM (
      SELECT id, venue_id FROM events
      WHERE status = 'published' AND starts_at > now()
      ORDER BY starts_at
      LIMIT ${EVENTS_WITH_INVENTORY}
    ) e
    JOIN venue_sections sec ON sec.venue_id = e.venue_id
    JOIN venue_seats vs ON vs.section_id = sec.id
  `.execute(db);
  log(
    `event_seats: ${inv.numAffectedRows} (for the next ${EVENTS_WITH_INVENTORY} upcoming published events)`,
  );

  // ---------------------------------------------------------------- sales history
  // About a third of those seats are already sold. Every sold seat belongs to a real
  // confirmed booking (the schema enforces that a non-available seat has a booking), so
  // group the sold seats into bookings of up to 3 seats, each for a random attendee.
  // All set-based SQL: a few statements instead of 100k round trips.
  await sql`
    CREATE TEMP TABLE seed_orders AS
    SELECT gen_random_uuid() AS booking_id, event_id, sum(price_cents)::int AS total, array_agg(id) AS seat_ids
    FROM (
      SELECT id, event_id, price_cents,
             (row_number() OVER (PARTITION BY event_id ORDER BY random()) - 1) / 3 AS grp
      FROM event_seats
      WHERE random() < 0.35
    ) sold
    GROUP BY event_id, grp
  `.execute(db);
  const orders = await sql`
    WITH buyers AS (SELECT array_agg(id) AS ids FROM users WHERE role = 'attendee')
    INSERT INTO bookings (id, user_id, event_id, status, total_cents, currency, expires_at, confirmed_at, created_at)
    SELECT o.booking_id,
           buyers.ids[1 + floor(random() * array_length(buyers.ids, 1))::int],
           o.event_id, 'confirmed', o.total, 'USD', now(), now(), now() - random() * interval '30 days'
    FROM seed_orders o, buyers
  `.execute(db);
  await sql`
    INSERT INTO booking_items (booking_id, event_seat_id, price_cents)
    SELECT o.booking_id, s.id, es.price_cents
    FROM seed_orders o
    CROSS JOIN unnest(o.seat_ids) AS s(id)
    JOIN event_seats es ON es.id = s.id
  `.execute(db);
  const sold = await sql`
    UPDATE event_seats es SET status = 'booked', booking_id = s.booking_id, version = 1
    FROM (SELECT booking_id, unnest(seat_ids) AS seat_id FROM seed_orders) s
    WHERE es.id = s.seat_id
  `.execute(db);
  // A confirmed booking has one valid ticket per seat (checked by npm run check:invariants).
  await sql`
    INSERT INTO tickets (booking_id, event_id, event_seat_id, created_at)
    SELECT o.booking_id, o.event_id, s.id, now()
    FROM seed_orders o CROSS JOIN unnest(o.seat_ids) AS s(id)
  `.execute(db);
  log(
    `bookings: ${orders.numAffectedRows} confirmed, covering ${sold.numAffectedRows} sold seats (with tickets)`,
  );

  // Some far-off shows aren't on sale yet: tickets go on sale 30 days before.
  await sql`
    UPDATE events SET sales_start_at = starts_at - interval '30 days'
    WHERE starts_at > now() + interval '60 days' AND random() < 0.3
  `.execute(db);

  await sql`ANALYZE`.execute(db); // refresh planner statistics after a bulk load
  log('done');
} finally {
  await db.destroy();
}
