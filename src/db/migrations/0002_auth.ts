import { sql, type Kysely } from 'kysely';

// Auth: password hashes, login sessions with rotating refresh tokens, and password resets.
//
// Why store sessions at all if access tokens are JWTs? The short-lived JWT makes the hot
// path (every API request) stateless. The session row makes login *revocable*: logout,
// "sign out everywhere", password reset, and refresh-token theft detection all work by
// revoking the session, which stops it from ever minting another access token.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- NULL means "no password set": such accounts can't log in until they complete a
    -- password reset. Existing rows (seed data) start that way; signup always sets one.
    ALTER TABLE users ADD COLUMN password_hash text;
    ALTER TABLE users ADD COLUMN password_changed_at timestamptz;

    CREATE TABLE sessions (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      created_at    timestamptz NOT NULL DEFAULT now(),
      last_used_at  timestamptz NOT NULL DEFAULT now(),
      expires_at    timestamptz NOT NULL,   -- absolute cap, not extended by refreshing
      revoked_at    timestamptz,
      revoke_reason text,
      user_agent    text,
      ip            inet
    );
    CREATE INDEX sessions_active_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

    -- Refresh tokens are 256-bit random strings. Only their SHA-256 is stored: a leaked
    -- table can't be replayed. A fast hash is fine here (unlike passwords) because the
    -- input has full entropy, so there's nothing to brute-force.
    CREATE TABLE refresh_tokens (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
      token_hash bytea NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      used_at    timestamptz            -- set when rotated; a second use means theft
    );
    CREATE INDEX refresh_tokens_session_idx ON refresh_tokens (session_id);

    CREATE TABLE password_reset_tokens (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      token_hash bytea NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      used_at    timestamptz
    );
    CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens (user_id);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE IF EXISTS password_reset_tokens, refresh_tokens, sessions;
    ALTER TABLE users DROP COLUMN IF EXISTS password_changed_at;
    ALTER TABLE users DROP COLUMN IF EXISTS password_hash;
  `.execute(db);
}
