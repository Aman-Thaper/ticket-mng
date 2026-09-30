import { sql, type Kysely } from 'kysely';

/**
 * Email verification. Tickets are delivered to the account's email address, so an address
 * has to be proven to work before it can book: signing up sends a confirmation link, and
 * holding seats requires a confirmed address.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE users ADD COLUMN email_verified_at timestamptz;
    -- Accounts created before verification existed keep working: treat them as confirmed.
    UPDATE users SET email_verified_at = created_at;

    -- Same shape as password_reset_tokens: only a hash of the token is stored, so a copy of
    -- the database can't be used to confirm anyone's address.
    CREATE TABLE email_verification_tokens (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      token_hash bytea NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      used_at    timestamptz
    );
    CREATE INDEX email_verification_tokens_user_idx ON email_verification_tokens (user_id);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE IF EXISTS email_verification_tokens;
    ALTER TABLE users DROP COLUMN IF EXISTS email_verified_at;
  `.execute(db);
}
