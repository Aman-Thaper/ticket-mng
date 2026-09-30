import { sql, type RawBuilder } from 'kysely';
import { db } from '../../db/index.js';
import { getQueue, type Jobs } from '../queues.js';
import type { JobHandler } from '../runner.js';

/**
 * Every 15 minutes: queue a reminder for each confirmed booking whose event starts in about
 * 24 hours. The 2-hour window is much wider than the 15-minute cadence, so a missed or slow
 * run is caught by the next one. The notification log (and the job id) make sure each
 * booking gets exactly one reminder anyway.
 */
export const sendEventReminders: JobHandler<Jobs['maintenance']['send-event-reminders']> = async (
  _job,
  log,
) => {
  const due = await db
    .selectFrom('bookings as b')
    .innerJoin('events as e', 'e.id', 'b.eventId')
    .select('b.id')
    .where('b.status', '=', 'confirmed')
    .where('e.status', '=', 'published')
    .where('e.startsAt', '>', sql<Date>`now() + interval '23 hours'`)
    .where('e.startsAt', '<=', sql<Date>`now() + interval '25 hours'`)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('notifications as n')
            .select('n.refId')
            .where('n.kind', '=', 'event-reminder')
            .whereRef('n.refId', '=', sql`b.id::text`),
        ),
      ),
    )
    .limit(5_000)
    .execute();

  if (due.length) {
    await getQueue('email').addBulk(
      due.map((b) => ({
        name: 'event-reminder',
        data: { bookingId: b.id },
        opts: { jobId: `event-reminder_${b.id}` },
      })),
    );
    log.info({ queued: due.length }, 'event reminders queued');
  }
  return { queued: due.length };
};

/** Delete in small batches, so no single statement holds locks or bloats WAL for long. */
async function deleteInBatches(
  table: string,
  condition: RawBuilder<boolean>,
  batch = 5_000,
): Promise<number> {
  let total = 0;
  for (;;) {
    const res = await sql`
      DELETE FROM ${sql.table(table)}
      WHERE ctid IN (SELECT ctid FROM ${sql.table(table)} WHERE ${condition} LIMIT ${batch})
    `.execute(db);
    const n = Number(res.numAffectedRows ?? 0n);
    total += n;
    if (n < batch) return total;
  }
}

/** Nightly housekeeping: drop rows nothing will ever read again. */
export const cleanup: JobHandler<Jobs['maintenance']['cleanup']> = async (_job, log) => {
  const deleted = {
    outbox: await deleteInBatches('outbox', sql`published_at < now() - interval '7 days'`),
    refreshTokens: await deleteInBatches('refresh_tokens', sql`expires_at < now() - interval '1 day'`),
    passwordResetTokens: await deleteInBatches(
      'password_reset_tokens',
      sql`expires_at < now() - interval '1 day'`,
    ),
    emailVerificationTokens: await deleteInBatches(
      'email_verification_tokens',
      sql`expires_at < now() - interval '1 day' OR used_at < now() - interval '1 day'`,
    ),
    idempotencyKeys: await deleteInBatches('idempotency_keys', sql`created_at < now() - interval '24 hours'`),
    webhookEvents: await deleteInBatches(
      'webhook_events',
      sql`processed_at IS NOT NULL AND received_at < now() - interval '30 days'`,
    ),
    sessions: await deleteInBatches(
      'sessions',
      sql`(revoked_at < now() - interval '30 days') OR (expires_at < now() - interval '1 day')`,
    ),
  };
  log.info(deleted, 'cleanup done');
  return deleted;
};
