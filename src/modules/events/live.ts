import { sql } from 'kysely';
import type { z } from 'zod';
import { config } from '../../config.js';
import { db } from '../../db/index.js';
import { MicroCache } from '../../lib/cache.js';
import { logger } from '../../lib/logger.js';
import { viewerTotals } from '../../realtime/viewers.js';
import type { LiveStatsDto } from './schemas.js';

type LiveStats = z.infer<typeof LiveStatsDto>;

/**
 * Tickets sold in the last hour, per event: seats in bookings confirmed within the hour. One
 * grouped query, served by the partial index bookings_event_confirmed_idx (migration 0010).
 * A refunded booking leaves 'confirmed', so it no longer counts as a sale.
 */
export async function soldLastHour(eventIds: string[]): Promise<Map<string, number>> {
  if (!eventIds.length) return new Map();
  const rows = await db
    .selectFrom('bookings as b')
    .innerJoin('bookingItems as bi', 'bi.bookingId', 'b.id')
    .where('b.eventId', 'in', eventIds)
    .where('b.status', '=', 'confirmed')
    .where('b.confirmedAt', '>', sql<Date>`now() - interval '1 hour'`)
    .groupBy('b.eventId')
    .select((eb) => ['b.eventId', eb.fn.countAll<number>().as('sold')])
    .execute();
  return new Map(rows.map((r) => [r.eventId, r.sold]));
}

/** Like availability: hot, changes constantly, so an in-process micro-cache and no invalidation. */
const liveCache = new MicroCache('live-stats', config.MICRO_CACHE_TTL_MS);

/** Viewers now and tickets sold in the last hour, for an event page. */
export async function liveStats(eventId: string): Promise<LiveStats> {
  const { body } = await liveCache.get(eventId, async () => {
    const [viewers, sold] = await Promise.all([
      // Best effort: without Redis the page still works, it just can't say who's watching.
      viewerTotals([eventId]).then(
        (totals) => totals.get(eventId) ?? 0,
        (err: unknown) => {
          logger.warn({ err, eventId }, 'viewer count unavailable');
          return null;
        },
      ),
      soldLastHour([eventId]),
    ]);
    return JSON.stringify({ viewers, soldLastHour: sold.get(eventId) ?? 0 } satisfies LiveStats);
  });
  return JSON.parse(body) as LiveStats;
}
