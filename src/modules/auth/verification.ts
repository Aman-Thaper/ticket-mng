import { sql, type Kysely, type Transaction } from 'kysely';
import { config } from '../../config.js';
import { db } from '../../db/index.js';
import type { DB } from '../../db/types.js';
import { forbiddenBecause } from '../../lib/errors.js';
import { hashToken, newOpaqueToken } from './tokens.js';

/*
 * Email verification.
 *
 * Tickets are delivered by email, so booking requires an address that is proven to reach
 * its owner: a typo at signup would otherwise mean tickets sent to a stranger, or nowhere.
 *
 *   signup ──(outbox)──▶ worker: new token, email with /verify-email#token=…
 *   click  ──▶ POST /auth/verify-email {token} ──▶ users.email_verified_at = now()
 *
 * The token is created by the worker, not in the signup request, so it never sits in the
 * outbox table or in Redis job data. Only its SHA-256 hash is stored. Unlike a password
 * reset token, a confirmation token grants nothing except "this address works", so several
 * can be valid at once (a resend doesn't invalidate the email already in the inbox).
 */

/** Create a confirmation token for the user; returns the raw token (only its hash is stored). */
export async function issueVerificationToken(conn: Kysely<DB> | Transaction<DB>, userId: string) {
  const token = newOpaqueToken();
  await conn
    .insertInto('emailVerificationTokens')
    .values({
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + config.EMAIL_VERIFICATION_TTL_HOURS * 3_600_000),
    })
    .execute();
  return token;
}

export type VerifyOutcome = 'verified' | 'already_verified' | 'invalid';

/**
 * Confirm the address a token was sent to. Opening the link twice (or on two devices) is
 * normal, so a token of an already-confirmed account answers "already verified" rather
 * than an error. Concurrent confirmations are harmless: the update only applies once.
 */
export async function verifyEmailToken(token: string): Promise<VerifyOutcome> {
  const row = await db
    .selectFrom('emailVerificationTokens as t')
    .innerJoin('users as u', 'u.id', 't.userId')
    .select(['t.userId', 't.expiresAt', 't.usedAt', 'u.emailVerifiedAt'])
    .where('t.tokenHash', '=', hashToken(token))
    .executeTakeFirst();
  if (!row) return 'invalid';
  if (row.emailVerifiedAt) return 'already_verified';
  if (row.usedAt || row.expiresAt <= new Date()) return 'invalid';

  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('users')
      .set({ emailVerifiedAt: sql`now()` })
      .where('id', '=', row.userId)
      .where('emailVerifiedAt', 'is', null)
      .execute();
    await trx
      .updateTable('emailVerificationTokens')
      .set({ usedAt: sql`now()` })
      .where('userId', '=', row.userId)
      .where('usedAt', 'is', null)
      .execute();
  });
  return 'verified';
}

/** Throws 403 EMAIL_NOT_VERIFIED unless the user has confirmed their address. */
export async function assertEmailVerified(userId: string): Promise<void> {
  const user = await db
    .selectFrom('users')
    .select('emailVerifiedAt')
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user?.emailVerifiedAt) {
    throw forbiddenBecause(
      'EMAIL_NOT_VERIFIED',
      'Confirm your email address to book tickets: they are sent to it. Check your inbox for our link, or ask for a new one.',
    );
  }
}
