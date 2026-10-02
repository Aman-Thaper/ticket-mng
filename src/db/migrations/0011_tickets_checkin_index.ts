import { sql, type Kysely } from 'kysely';

/**
 * Live attendance at the door: "312 of 480 checked in" and the last few scans, polled every
 * few seconds by each scanner and the organizer's dashboard. Ordered by check-in time within
 * an event, so the latest scans are the first entries of one range scan instead of a sort of
 * every ticket at the event. Partial: tickets not yet scanned aren't in it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX tickets_event_checkin_idx ON tickets (event_id, checked_in_at DESC)
      WHERE checked_in_at IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS tickets_event_checkin_idx`.execute(db);
}
