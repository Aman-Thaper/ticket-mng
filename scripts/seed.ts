/**
 * Fills the dev database with realistic volume so slow queries show up:
 *   50k users, 500 venues (~430k physical seats), 200k events over two years, and a catalog of
 *   ~1,000 upcoming events on sale over the next 60 days (~860k seats, a varied share already
 *   sold as confirmed bookings with tickets: some events sold out, most with plenty left).
 *   Takes about a minute. As those events pass, `npm run stock` tops the catalog up.
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
import { CITY_TIMEZONES, describeEvent, eventTitle, startSlot, stockEvents } from './lib/catalog.js';

const USERS = Number(process.env.SEED_USERS ?? 50_000);
const VENUES = Number(process.env.SEED_VENUES ?? 500);
const EVENTS_PER_VENUE = Number(process.env.SEED_EVENTS_PER_VENUE ?? 400);
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
      INSERT INTO users (email, name, role, password_hash, password_changed_at, email_verified_at)
      SELECT *, ${passwordHash}, now(), now() FROM unnest(
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
      const city = faker.helpers.arrayElement([...Object.keys(CITY_TIMEZONES), faker.location.city()]);
      const venue = await trx
        .insertInto('venues')
        .values({
          name: `${faker.location.city()} ${faker.helpers.arrayElement(['Arena', 'Hall', 'Theatre', 'Stadium', 'Club', 'Amphitheatre'])}`,
          address: faker.location.streetAddress(),
          city,
          country: faker.location.countryCode('alpha-2'),
          timezone: CITY_TIMEZONES[city] ?? 'UTC',
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
  // Start times are wall-clock times at the venue ("19:30 on 2026-10-05" in Toronto), turned
  // into instants by Postgres with the venue's time zone. One event per day at most per venue,
  // so the venue-overlap constraint is never hit.
  type EventRow = {
    organizerId: string;
    venueId: string;
    title: string;
    description: string;
    category: EventCategory;
    status: EventStatus;
    localStart: string;
    hours: number;
  };
  const events: EventRow[] = [];
  const DAY = 86_400_000;
  const today = new Date(new Date().toISOString().slice(0, 10)).getTime();
  for (const venueId of venueIds) {
    let day = today - 365 * DAY + faker.number.int({ min: 0, max: 2 }) * DAY;
    for (let i = 0; i < EVENTS_PER_VENUE; i++) {
      day += faker.number.int({ min: 1, max: 3 }) * DAY;
      const hours = faker.number.int({ min: 2, max: 5 });
      const category = faker.helpers.weightedArrayElement(
        EVENT_CATEGORIES.map((c) => ({ value: c, weight: c === 'concert' ? 5 : c === 'other' ? 1 : 2 })),
      );
      const name = eventTitle(category);
      events.push({
        organizerId: faker.helpers.arrayElement(organizerIds),
        venueId,
        title: name,
        description: describeEvent(category, name),
        category,
        status: faker.helpers.weightedArrayElement([
          { value: 'published' as const, weight: 85 },
          { value: 'draft' as const, weight: 10 },
          { value: 'cancelled' as const, weight: 5 },
        ]),
        localStart: `${new Date(day).toISOString().slice(0, 10)} ${startSlot(category)}`,
        hours,
      });
    }
  }

  for (const batch of chunks(events, BATCH)) {
    await sql`
      INSERT INTO events (organizer_id, venue_id, title, description, category, status, starts_at, ends_at)
      SELECT d.organizer_id, d.venue_id, d.title, d.description, d.category, d.status,
             d.local_start AT TIME ZONE v.timezone,
             (d.local_start AT TIME ZONE v.timezone) + make_interval(hours => d.hours)
      FROM unnest(
        ${batch.map((e) => e.organizerId)}::uuid[],
        ${batch.map((e) => e.venueId)}::uuid[],
        ${batch.map((e) => e.title)}::text[],
        ${batch.map((e) => e.description)}::text[],
        ${batch.map((e) => e.category)}::event_category[],
        ${batch.map((e) => e.status)}::event_status[],
        ${batch.map((e) => e.localStart)}::timestamp[],
        ${batch.map((e) => e.hours)}::int[]
      ) AS d(organizer_id, venue_id, title, description, category, status, local_start, hours)
      JOIN venues v ON v.id = d.venue_id
    `.execute(db);
  }
  log(`events: ${events.length}`);

  // ---------------------------------------------------------------- the on-sale catalog
  // Seats for ~1,000 upcoming events spread over 60 days, with a varied share already sold.
  // Giving every event its seats would mean roughly 140M rows.
  await stockEvents(db, { days: 60, target: 1_000, log });

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
