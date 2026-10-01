import { sql, type Kysely } from 'kysely';

/**
 * A venue's time zone (IANA name, e.g. Europe/London). Times are stored as UTC instants; a
 * show at a Toronto venue starts at "7:30 PM Toronto time" whoever is looking, so pages and
 * emails format event times in the venue's zone, not the viewer's.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE venues ADD COLUMN timezone text NOT NULL DEFAULT 'UTC';
    -- The cities the seed uses. Venues anywhere else stay on UTC until someone sets theirs.
    UPDATE venues SET timezone = CASE city
      WHEN 'London'   THEN 'Europe/London'
      WHEN 'Berlin'   THEN 'Europe/Berlin'
      WHEN 'Paris'    THEN 'Europe/Paris'
      WHEN 'New York' THEN 'America/New_York'
      WHEN 'Toronto'  THEN 'America/Toronto'
      WHEN 'Mumbai'   THEN 'Asia/Kolkata'
      WHEN 'Tokyo'    THEN 'Asia/Tokyo'
      WHEN 'Sydney'   THEN 'Australia/Sydney'
      ELSE 'UTC'
    END;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE venues DROP COLUMN IF EXISTS timezone`.execute(db);
}
