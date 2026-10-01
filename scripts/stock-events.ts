/**
 * Put upcoming events on sale: seats for ~1,000 events spread over the next 60 days, readable
 * descriptions, and a realistic share of seats already sold. Idempotent: it only stocks events
 * that have no seats yet, so run it again whenever the catalog runs low (events pass).
 *
 *   npm run stock
 *   npm run stock -- --days 90 --target 1500
 *
 * Keeps everything else (accounts, your own bookings). The seed does the same on a fresh database.
 */
import { parseArgs } from 'node:util';
import { sql } from 'kysely';
import { config } from '../src/config.js';
import { db } from '../src/db/index.js';
import { bumpGenerations, generationKey } from '../src/lib/cache.js';
import { redis } from '../src/lib/redis.js';
import { stockEvents } from './lib/catalog.js';

const { values } = parseArgs({
  options: { days: { type: 'string', default: '60' }, target: { type: 'string', default: '1000' } },
});
if (config.NODE_ENV === 'production') {
  throw new Error('Refusing to stock a production database: it creates bookings for fake attendees');
}

const started = Date.now();
const log = (msg: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${msg}`);
try {
  const result = await stockEvents(db, { days: Number(values.days), target: Number(values.target), log });
  await sql`ANALYZE event_seats, bookings, booking_items, tickets`.execute(db);
  // Cached listings and event pages predate the new seats: start new cache generations.
  await bumpGenerations(generationKey.eventLists, ...result.eventIds.map((id) => generationKey.event(id)));
  log(`done: ${result.events} events on sale`);
} finally {
  await Promise.all([db.destroy(), redis.quit()]);
}
