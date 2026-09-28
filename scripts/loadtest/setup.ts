/**
 * Prepare a flash sale for k6: one hot event (2,000 seats, on sale now) and a crowd of
 * buyers with ready-made access tokens. Writes .dev/loadtest.json for the k6 script.
 *
 *   npm run loadtest:setup -- --users 5000
 *
 * Uses the dev database. Access tokens last ACCESS_TOKEN_TTL_SECONDS (15 min by default),
 * so run k6 within that window.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { sql } from 'kysely';
import { db } from '../../src/db/index.js';
import { redis } from '../../src/lib/redis.js';
import { startSession } from '../../src/modules/auth/sessions.js';
import { generateSeats } from '../../src/modules/venues/layout.js';

const { values } = parseArgs({
  options: {
    users: { type: 'string', default: '5000' },
    'base-url': { type: 'string', default: 'http://localhost:8080' },
  },
});
const USERS = Number(values.users);
const tag = `loadtest-${Date.now()}`;

const organizer = await db
  .insertInto('users')
  .values({ email: `${tag}-organizer@example.com`, name: 'Load Test Organizer', role: 'organizer' })
  .returning('id')
  .executeTakeFirstOrThrow();

const sections = [
  { name: 'Floor', rows: 20, seatsPerRow: 25 },
  { name: 'Lower Tier', rows: 20, seatsPerRow: 25 },
  { name: 'Upper Tier', rows: 20, seatsPerRow: 25 },
  { name: 'Balcony', rows: 20, seatsPerRow: 25 },
];
const seats = generateSeats(sections);
const venue = await db
  .insertInto('venues')
  .values({
    name: `${tag} Arena`,
    address: '1 Load St',
    city: 'Benchville',
    country: 'US',
    capacity: seats.length,
  })
  .returning('id')
  .executeTakeFirstOrThrow();
const sectionRows = await db
  .insertInto('venueSections')
  .values(sections.map((s, i) => ({ venueId: venue.id, name: s.name, sortOrder: i })))
  .returning(['id', 'name'])
  .execute();
const sectionId = new Map(sectionRows.map((s) => [s.name, s.id]));
await sql`
  INSERT INTO venue_seats (section_id, row_label, seat_number, x, y)
  SELECT * FROM unnest(
    ${seats.map((s) => sectionId.get(s.section))}::uuid[], ${seats.map((s) => s.rowLabel)}::text[],
    ${seats.map((s) => s.seatNumber)}::int[], ${seats.map((s) => s.x)}::int[], ${seats.map((s) => s.y)}::int[])
`.execute(db);

const startsAt = new Date(Date.now() + 30 * 86_400_000);
const event = await db
  .insertInto('events')
  .values({
    organizerId: organizer.id,
    venueId: venue.id,
    title: 'The Flash Sale',
    category: 'concert',
    status: 'published',
    startsAt,
    endsAt: new Date(startsAt.getTime() + 3 * 3_600_000),
    maxTicketsPerUser: 4,
  })
  .returning('id')
  .executeTakeFirstOrThrow();
await sql`
  INSERT INTO event_seats (event_id, venue_seat_id, price_cents)
  SELECT ${event.id}::uuid, vs.id, 12000 - sec.sort_order * 2000
  FROM venue_seats vs JOIN venue_sections sec ON sec.id = vs.section_id
  WHERE sec.venue_id = ${venue.id}::uuid
`.execute(db);
const seatIds = (
  await db.selectFrom('eventSeats').select('id').where('eventId', '=', event.id).execute()
).map((s) => s.id);

const buyers = await db
  .insertInto('users')
  .values(
    Array.from({ length: USERS }, (_, i) => ({
      email: `${tag}-${i}@example.com`,
      name: `Buyer ${i}`,
      role: 'attendee' as const,
    })),
  )
  .returning(['id', 'role'])
  .execute();
const tokens: string[] = [];
for (let i = 0; i < buyers.length; i += 200) {
  const batch = await Promise.all(
    buyers.slice(i, i + 200).map(async (b) => (await startSession(db, b, {})).accessToken),
  );
  tokens.push(...batch);
}

mkdirSync('.dev', { recursive: true });
writeFileSync(
  '.dev/loadtest.json',
  JSON.stringify({ baseUrl: values['base-url'], eventId: event.id, seatIds, tokens }),
);
console.log(`event ${event.id}: ${seatIds.length} seats, ${tokens.length} buyers → .dev/loadtest.json`);
console.log(`watch it live: ${values['base-url']}/?event=${event.id}`);
await Promise.all([db.destroy(), redis.quit()]);
