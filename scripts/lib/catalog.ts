import { faker } from '@faker-js/faker';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB, EventCategory } from '../../src/db/types.js';

/**
 * Realistic catalog data, shared by the seed and `npm run stock`:
 *   - readable titles and English descriptions per category;
 *   - start times that make sense locally (evening concerts, afternoon matches), in the
 *     venue's time zone;
 *   - "stocking" upcoming events: seats for sale, and a varied share already sold, so the
 *     catalog has sold-out shows, nearly-full ones and fresh ones.
 */

/** Time zones of the cities the seed uses (same as migration 0009). Elsewhere: UTC. */
export const CITY_TIMEZONES: Record<string, string> = {
  London: 'Europe/London',
  Berlin: 'Europe/Berlin',
  Paris: 'Europe/Paris',
  'New York': 'America/New_York',
  Toronto: 'America/Toronto',
  Mumbai: 'Asia/Kolkata',
  Tokyo: 'Asia/Tokyo',
  Sydney: 'Australia/Sydney',
};

/** Local wall-clock start times that make sense for each kind of event. */
const START_SLOTS: Record<EventCategory, readonly string[]> = {
  concert: ['19:00', '19:30', '20:00', '20:30'],
  theatre: ['14:30', '19:00', '19:30'],
  comedy: ['19:30', '20:00', '21:00'],
  sports: ['13:00', '15:00', '17:30', '19:45'],
  festival: ['11:00', '12:00', '14:00'],
  other: ['10:00', '18:30', '19:00'],
};

const pick = <T>(items: readonly T[]) => faker.helpers.arrayElement(items);
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const startSlot = (category: EventCategory) => pick(START_SLOTS[category]);

// Matinee and late slots to try when every usual slot clashes with another show that day.
const FALLBACK_SLOTS = ['13:00', '16:00', '21:30'];

/**
 * Move events that start at odd local hours (an older seed spread start times over the whole
 * day) to a sensible slot on the same local date, in the venue's time zone. Tries the
 * category's usual slots in random order, then matinee/late ones; an event that would overlap
 * another one at its venue in every slot keeps its time.
 */
export async function retimeOddHours(db: Kysely<DB>, events: { id: string; category: EventCategory }[]) {
  let moved = 0;
  for (const event of events) {
    for (const slot of [...faker.helpers.shuffle([...START_SLOTS[event.category]]), ...FALLBACK_SLOTS]) {
      if (await retimeTo(db, event.id, slot)) {
        moved++;
        break;
      }
    }
  }
  return moved;
}

/** Move one event to `slot` (local time at its venue, same local date). False if it can't. */
async function retimeTo(db: Kysely<DB>, eventId: string, slot: string): Promise<boolean> {
  try {
    // (local date at the venue + a sensible local time) AT TIME ZONE venue → the new instant.
    const res = await sql`
      UPDATE events e
      SET starts_at = n.start, ends_at = n.start + n.length
      FROM (
        SELECT x.id, x.venue_id, x.ends_at - x.starts_at AS length,
               ((x.starts_at AT TIME ZONE v.timezone)::date + ${slot}::time) AT TIME ZONE v.timezone AS start
        FROM events x JOIN venues v ON v.id = x.venue_id
        WHERE x.id = ${eventId}
          AND extract(hour FROM x.starts_at AT TIME ZONE v.timezone) NOT BETWEEN 10 AND 22
      ) n
      WHERE e.id = n.id
        AND n.start > now()
        AND NOT EXISTS (
          SELECT 1 FROM events o
          WHERE o.venue_id = n.venue_id AND o.id <> n.id AND o.status <> 'cancelled'
            AND tstzrange(o.starts_at, o.ends_at) && tstzrange(n.start, n.start + n.length)
        )
    `.execute(db);
    return Number(res.numAffectedRows ?? 0) > 0;
  } catch (err) {
    // 23P01: overlaps after all (a concurrent change); keep the original time.
    if ((err as { code?: string }).code !== '23P01') throw err;
    return false;
  }
}

export function eventTitle(category: EventCategory): string {
  switch (category) {
    case 'concert':
      return `${faker.music.artist()} Live`;
    case 'festival':
      return `${faker.location.city()} ${faker.music.genre()} Festival`;
    case 'comedy':
      return `${faker.person.fullName()}: ${pick(['Live', 'Unfiltered', 'Work in Progress', 'The World Tour', 'One Night Only', 'Late and Loud', 'No Notes'])}`;
    case 'theatre':
      return faker.book.title();
    case 'sports':
      return `${faker.location.city()} vs ${faker.location.city()}`;
    case 'other':
      return pick([
        `${faker.location.city()} Food & Wine Evening`,
        `An Evening of Magic with ${faker.person.firstName()}`,
        `${faker.location.city()} Science Night`,
        `Live Podcast: ${capitalize(faker.word.adjective())} ${capitalize(faker.word.noun())}`,
        `Jazz Brunch at ${faker.location.city()}`,
        `${capitalize(faker.word.adjective())} Cinema: A Live Score Screening`,
        `Silent Disco: ${faker.music.genre()} Night`,
      ]);
  }
}

export function describeEvent(category: EventCategory, title: string): string {
  switch (category) {
    case 'concert':
      return pick([
        `${title} brings ${faker.music.genre().toLowerCase()} to the stage for one night only. Expect the hits, a few surprises from the new record, and a crowd that sings every word.`,
        `A full live show from ${title.replace(/ Live$/, '')}: ${faker.number.int({ min: 18, max: 26 })} songs, a new stage production and a support act chosen by the band.`,
        `${title}: the tour everyone has been waiting for. Doors open an hour before the show; the support act starts 45 minutes later.`,
      ]);
    case 'theatre':
      return pick([
        `A new production of ${title}, staged in the round with live music. Running time about ${faker.number.int({ min: 2, max: 3 })} hours, including one interval.`,
        `${title} returns in an acclaimed staging that critics called "${faker.word.adjective()} and unmissable". Suitable for ages 12 and up.`,
        `An intimate, modern take on ${title}, with an ensemble cast of ${faker.number.int({ min: 6, max: 14 })}. Latecomers are admitted at the interval.`,
      ]);
    case 'comedy':
      return pick([
        `${title.split(':')[0]} brings a brand-new hour of stand-up, tested in small clubs and ready for the big room. Ages 18+.`,
        `One night, ${faker.number.int({ min: 3, max: 6 })} comedians, no filter: a showcase headlined by ${title.split(':')[0]}. Ages 16+; some strong language.`,
      ]);
    case 'sports':
      return pick([
        `${title}: a decisive fixture with the season on the line. Gates open 90 minutes before kick-off; bags larger than A4 aren't allowed.`,
        `Derby day. ${title}, live, with the stadium's family zone open and pre-match entertainment from an hour before the start.`,
      ]);
    case 'festival':
      return pick([
        `${title} returns with ${faker.number.int({ min: 20, max: 60 })} acts across ${faker.number.int({ min: 2, max: 5 })} stages, street food from local vendors and late-night sets.`,
        `A full day of music at ${title}: headliners at sunset, a dedicated family area, and free water refill stations all day.`,
      ]);
    case 'other':
      return pick([
        `${title}: an evening of talks, live demos and conversation with people building what's next. Drinks included.`,
        `${title}, a one-off live experience. Arrive early: seating is allocated, but the bar opens an hour before.`,
      ]);
  }
}

export interface StockOptions {
  /** Look this many days ahead for events to put on sale. */
  days: number;
  /** About how many events to stock, spread evenly over those days. */
  target: number;
  log?: (message: string) => void;
}

/**
 * Put upcoming published events on sale: give them seats (priced by section), readable
 * descriptions, and a realistic share of seats already sold, as real confirmed bookings with
 * tickets (the invariants checker must keep passing). Picks events spread evenly over the
 * window, among those without seats yet, so running it again tops the catalog up.
 *
 * Sold seats go to seeded attendees (@example.com) only, never to real accounts.
 */
export async function stockEvents(db: Kysely<DB>, { days, target, log = () => {} }: StockOptions) {
  const candidates = await sql<{ id: string; title: string; category: EventCategory }>`
    WITH open AS (
      SELECT e.id, e.title, e.category,
             row_number() OVER (ORDER BY e.starts_at, e.id) AS n, count(*) OVER () AS total
      FROM events e
      WHERE e.status = 'published' AND e.starts_at > now()
        AND e.starts_at < now() + make_interval(days => ${days})
        AND NOT EXISTS (SELECT 1 FROM event_seats es WHERE es.event_id = e.id)
    )
    SELECT id, title, category FROM open WHERE n % greatest(1, total / ${target}) = 0 LIMIT ${target}
  `.execute(db);
  // Older seeds named comedy and "other" events oddly; give the ones going on sale proper titles.
  const events = candidates.rows.map((e) =>
    e.category === 'comedy' || e.category === 'other' ? { ...e, title: eventTitle(e.category) } : e,
  );
  if (!events.length) {
    log('no upcoming events without seats in that window; nothing to stock');
    return { events: 0, eventIds: [], seats: 0, bookings: 0 };
  }
  const ids = events.map((e) => e.id);
  const retimed = await retimeOddHours(db, events);
  if (retimed) log(`moved ${retimed} events from odd hours to sensible local start times`);

  // One transaction: all or nothing, and one connection, which the temp table below needs.
  return db.transaction().execute(async (trx) => {
    await sql`
      UPDATE events e SET title = d.title, description = d.description, sales_start_at = NULL
      FROM unnest(
        ${ids}::uuid[],
        ${events.map((e) => e.title)}::text[],
        ${events.map((e) => describeEvent(e.category, e.title))}::text[]
      ) AS d(id, title, description)
      WHERE e.id = d.id
    `.execute(trx);

    // Front sections cost more: $120, $95, $70, $45, then $20.
    const inventory = await sql`
      INSERT INTO event_seats (event_id, venue_seat_id, price_cents)
      SELECT e.id, vs.id, greatest(2000, 12000 - sec.sort_order * 2500)
      FROM events e
      JOIN venue_sections sec ON sec.venue_id = e.venue_id
      JOIN venue_seats vs ON vs.section_id = sec.id
      WHERE e.id = ANY(${ids}::uuid[])
    `.execute(trx);
    log(`stocked ${events.length} events with ${inventory.numAffectedRows} seats`);

    const { bookings } = await sellShare(trx, ids, log);

    return {
      events: events.length,
      eventIds: ids,
      seats: Number(inventory.numAffectedRows ?? 0),
      bookings,
    };
  });
}

/**
 * Sell a realistic share of these events' seats: most events have plenty left, some are
 * selling fast, and a few are sold out. Each order is up to 3 seats for a random seeded
 * attendee (@example.com, never a real account), a confirmed booking with one ticket per
 * seat, so the invariants checker keeps passing. Run inside a transaction: the temp table
 * lives on its connection.
 */
export async function sellShare(
  trx: Transaction<DB>,
  ids: string[],
  log: (message: string) => void = () => {},
) {
  await sql`
    CREATE TEMP TABLE stock_orders ON COMMIT DROP AS
    WITH share AS MATERIALIZED (
      SELECT id AS event_id,
             CASE WHEN random() < 0.05 THEN 1.0 ELSE power(random(), 1.7) * 0.93 END AS sold
      FROM unnest(${ids}::uuid[]) AS id
    ),
    seats AS MATERIALIZED (
      SELECT id, event_id, price_cents, random() AS roll
      FROM event_seats WHERE event_id = ANY(${ids}::uuid[])
    ),
    picked AS (
      -- Compare each seat's own roll. "WHERE random() < s.sold" would mention only the
      -- per-event row, so Postgres may evaluate it once per event: all seats or none.
      SELECT st.id, st.event_id, st.price_cents,
             (row_number() OVER (PARTITION BY st.event_id ORDER BY st.roll) - 1) / 3 AS grp
      FROM seats st JOIN share s ON s.event_id = st.event_id
      WHERE st.roll < s.sold
    )
    SELECT gen_random_uuid() AS booking_id, event_id, sum(price_cents)::int AS total, array_agg(id) AS seat_ids
    FROM picked GROUP BY event_id, grp
  `.execute(trx);
  const orders = await sql`
    WITH buyers AS (
      SELECT array_agg(id) AS ids FROM users WHERE role = 'attendee' AND email LIKE '%@example.com'
    )
    INSERT INTO bookings (id, user_id, event_id, status, total_cents, currency, expires_at, confirmed_at, created_at)
    SELECT o.booking_id, buyers.ids[1 + floor(random() * array_length(buyers.ids, 1))::int],
           o.event_id, 'confirmed', o.total, 'USD', now(), now(), now() - random() * interval '20 days'
    FROM stock_orders o, buyers
    WHERE array_length(buyers.ids, 1) > 0
  `.execute(trx);
  await sql`
    INSERT INTO booking_items (booking_id, event_seat_id, price_cents)
    SELECT o.booking_id, s.id, es.price_cents
    FROM stock_orders o CROSS JOIN unnest(o.seat_ids) AS s(id) JOIN event_seats es ON es.id = s.id
    WHERE EXISTS (SELECT 1 FROM bookings b WHERE b.id = o.booking_id)
  `.execute(trx);
  const sold = await sql`
    UPDATE event_seats es SET status = 'booked', booking_id = s.booking_id, version = 1
    FROM (
      SELECT o.booking_id, unnest(o.seat_ids) AS seat_id FROM stock_orders o
      WHERE EXISTS (SELECT 1 FROM bookings b WHERE b.id = o.booking_id)
    ) s
    WHERE es.id = s.seat_id
  `.execute(trx);
  // A confirmed booking has one valid ticket per seat (npm run check:invariants checks it).
  await sql`
    INSERT INTO tickets (booking_id, event_id, event_seat_id, created_at)
    SELECT o.booking_id, o.event_id, s.id, now()
    FROM stock_orders o CROSS JOIN unnest(o.seat_ids) AS s(id)
    WHERE EXISTS (SELECT 1 FROM bookings b WHERE b.id = o.booking_id)
  `.execute(trx);
  log(`sold ${sold.numAffectedRows} of those seats in ${orders.numAffectedRows} bookings (with tickets)`);
  return { bookings: Number(orders.numAffectedRows ?? 0), sold: Number(sold.numAffectedRows ?? 0) };
}
