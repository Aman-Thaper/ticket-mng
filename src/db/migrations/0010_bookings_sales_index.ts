import { sql, type Kysely } from 'kysely';

/**
 * An event's sales by time: "86 sold in the last hour" on event pages, and sales over time
 * on the organizer dashboard. Both read one event's confirmed bookings by confirmation time.
 *
 * bookings_event_idx (event_id, status) finds an event's confirmed bookings, but then every
 * one of them must be fetched to check confirmed_at: a show with 2,000 bookings costs 2,000
 * heap reads to count the last hour's 12. This index is ordered by confirmed_at within each
 * event, so the last hour is one short range scan. Partial (confirmed only), because nothing
 * asks when an expired hold was "confirmed".
 *
 * A plain CREATE INDEX blocks writes to bookings while it builds: well under a second at this
 * size. On a large live table, build it CONCURRENTLY instead, which can't run inside the
 * migration's transaction, so it would be a separate, non-transactional step.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX bookings_event_confirmed_idx ON bookings (event_id, confirmed_at)
      WHERE status = 'confirmed'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS bookings_event_confirmed_idx`.execute(db);
}
