import { sql, type Kysely } from 'kysely';

/**
 * Remember the email provider's id for every notification (Resend returns one per email), so
 * "did the ticket email go out?" can be answered by looking it up in the provider's dashboard.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE notifications ADD COLUMN provider_message_id text`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE notifications DROP COLUMN IF EXISTS provider_message_id`.execute(db);
}
