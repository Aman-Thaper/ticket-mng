import { sql } from 'kysely';
import { db } from '../../db/index.js';
import { expireBooking } from '../../modules/bookings/service.js';
import type { Jobs } from '../queues.js';
import type { JobHandler } from '../runner.js';

/**
 * Scheduled for the exact moment a hold lapses. Correctness doesn't depend on it (a lapsed
 * hold already counts as free), but it frees the seats in the table and, from Phase 6,
 * tells live seat maps they're available again.
 */
export const expireBookingJob: JobHandler<Jobs['bookings']['expire-booking']> = async (job) => {
  const released = await expireBooking(job.data.bookingId);
  return { released: released.length };
};

const SWEEP_BATCH = 500;

/**
 * Safety net, every 30 seconds, for anything the per-booking job missed: Redis was flushed,
 * the job was lost, or seats were orphaned when a competing hold took over part of a lapsed
 * booking. Uses tiny partial indexes, so it costs almost nothing when there's nothing to do.
 */
export const sweepExpiredHolds: JobHandler<Jobs['bookings']['sweep-expired-holds']> = async (_job, log) => {
  const lapsed = await db
    .selectFrom('bookings')
    .select('id')
    .where('status', '=', 'pending')
    .where('expiresAt', '<=', sql<Date>`now() - interval '5 seconds'`)
    .orderBy('expiresAt')
    .limit(SWEEP_BATCH)
    .execute();

  const orphaned = await db
    .selectFrom('eventSeats as es')
    .innerJoin('bookings as b', 'b.id', 'es.bookingId')
    .select('b.id')
    .distinct()
    .where('es.status', '=', 'held')
    .where('b.status', '!=', 'pending')
    .limit(SWEEP_BATCH)
    .execute();

  const ids = [...new Set([...lapsed, ...orphaned].map((r) => r.id))];
  let released = 0;
  for (const id of ids) released += (await expireBooking(id)).length;
  if (ids.length) log.info({ bookings: ids.length, released }, 'swept lapsed holds');
  return { bookings: ids.length, released };
};
