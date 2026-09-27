import type { Kysely, Transaction } from 'kysely';
import { config } from '../../config.js';
import { db } from '../../db/index.js';
import type { DB, UserRole } from '../../db/types.js';
import { unauthorized } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { redis } from '../../lib/redis.js';
import { hashToken, newOpaqueToken, signAccessToken } from './tokens.js';

const DAY_MS = 86_400_000;

/**
 * A rotated refresh token presented again within this window is treated as a benign race,
 * e.g. two browser tabs refreshing at the same moment, and gets a fresh token too. Later
 * than that, a second use means the token was copied, so the whole session is revoked.
 */
const REUSE_LEEWAY_MS = 10_000;

type Conn = Kysely<DB> | Transaction<DB>;

export interface SessionMeta {
  userAgent?: string;
  ip?: string;
}

export interface IssuedTokens {
  sessionId: string;
  accessToken: string;
  /** seconds */
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
}

async function issueRefreshToken(conn: Conn, sessionId: string, sessionExpiresAt: Date) {
  const refreshToken = newOpaqueToken();
  const refreshExpiresAt = new Date(
    Math.min(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * DAY_MS, sessionExpiresAt.getTime()),
  );
  await conn
    .insertInto('refreshTokens')
    .values({ sessionId, tokenHash: hashToken(refreshToken), expiresAt: refreshExpiresAt })
    .execute();
  return { refreshToken, refreshExpiresAt };
}

async function issueTokens(
  user: { id: string; role: UserRole },
  sessionId: string,
  refresh: { refreshToken: string; refreshExpiresAt: Date },
): Promise<IssuedTokens> {
  const accessToken = await signAccessToken({ sub: user.id, sid: sessionId, role: user.role });
  return { sessionId, accessToken, expiresIn: config.ACCESS_TOKEN_TTL_SECONDS, ...refresh };
}

/** Log in: a new session (one per device/login) with its first refresh token. */
export async function startSession(
  conn: Conn,
  user: { id: string; role: UserRole },
  meta: SessionMeta,
): Promise<IssuedTokens> {
  const expiresAt = new Date(Date.now() + config.SESSION_MAX_DAYS * DAY_MS);
  const { id } = await conn
    .insertInto('sessions')
    .values({
      userId: user.id,
      expiresAt,
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
      ip: meta.ip ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return issueTokens(user, id, await issueRefreshToken(conn, id, expiresAt));
}

/**
 * Exchange a refresh token for a new access token and a new refresh token (rotation).
 * The old refresh token is marked used; presenting it again later revokes the session.
 * That's how a stolen token is detected: the thief and the real user both end up using the
 * same token, and whoever comes second trips the alarm.
 */
export async function rotateRefreshToken(token: string): Promise<{ userId: string; tokens: IssuedTokens }> {
  // Outcomes are returned rather than thrown so that the revocation performed on reuse is
  // committed. Throwing inside the transaction would roll it back.
  const outcome = await db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('refreshTokens as rt')
      .innerJoin('sessions as s', 's.id', 'rt.sessionId')
      .innerJoin('users as u', 'u.id', 's.userId')
      .select([
        'rt.id as tokenId',
        'rt.expiresAt',
        'rt.usedAt',
        's.id as sessionId',
        's.expiresAt as sessionExpiresAt',
        's.revokedAt',
        'u.id as userId',
        'u.role',
      ])
      .where('rt.tokenHash', '=', hashToken(token))
      // Serializes concurrent refreshes of the same token, so exactly one of them sees usedAt = NULL.
      .forUpdate('rt')
      .executeTakeFirst();

    if (!row) return { kind: 'invalid' } as const;
    if (row.revokedAt) return { kind: 'revoked' } as const;

    const now = Date.now();
    if (row.usedAt && now - row.usedAt.getTime() > REUSE_LEEWAY_MS) {
      await trx
        .updateTable('sessions')
        .set({ revokedAt: new Date(), revokeReason: 'refresh_token_reuse' })
        .where('id', '=', row.sessionId)
        .execute();
      return { kind: 'reused', sessionId: row.sessionId } as const;
    }
    if (row.expiresAt.getTime() <= now || row.sessionExpiresAt.getTime() <= now) {
      return { kind: 'expired' } as const;
    }

    if (!row.usedAt) {
      await trx
        .updateTable('refreshTokens')
        .set({ usedAt: new Date() })
        .where('id', '=', row.tokenId)
        .execute();
    }
    await trx
      .updateTable('sessions')
      .set({ lastUsedAt: new Date() })
      .where('id', '=', row.sessionId)
      .execute();

    // The role is re-read from the database on every refresh, so role changes reach the
    // access token within one access-token lifetime at most.
    const refresh = await issueRefreshToken(trx, row.sessionId, row.sessionExpiresAt);
    const tokens = await issueTokens({ id: row.userId, role: row.role }, row.sessionId, refresh);
    return { kind: 'ok', userId: row.userId, tokens } as const;
  });

  switch (outcome.kind) {
    case 'ok':
      return { userId: outcome.userId, tokens: outcome.tokens };
    case 'reused':
      logger.warn({ sessionId: outcome.sessionId }, 'refresh token reuse detected; session revoked');
      await denylistSessions([outcome.sessionId]);
      throw unauthorized('REFRESH_TOKEN_REUSED', 'Refresh token was already used; please log in again');
    case 'revoked':
      throw unauthorized('SESSION_REVOKED', 'Session has been revoked; please log in again');
    case 'expired':
      throw unauthorized('REFRESH_TOKEN_EXPIRED', 'Session has expired; please log in again');
    case 'invalid':
      throw unauthorized('INVALID_REFRESH_TOKEN', 'Refresh token is invalid');
  }
}

/** Revoke sessions inside the caller's transaction. Call denylistSessions() after commit. */
export async function revokeSessions(
  conn: Conn,
  where: { userId: string; sessionId?: string; exceptSessionId?: string },
  reason: string,
): Promise<string[]> {
  let q = conn
    .updateTable('sessions')
    .set({ revokedAt: new Date(), revokeReason: reason })
    .where('userId', '=', where.userId)
    .where('revokedAt', 'is', null);
  if (where.sessionId) q = q.where('id', '=', where.sessionId);
  if (where.exceptSessionId) q = q.where('id', '!=', where.exceptSessionId);
  const rows = await q.returning('id').execute();
  return rows.map((r) => r.id);
}

// Access tokens are verified without a database lookup, so a revoked session's tokens would
// otherwise stay valid until they expire (up to ACCESS_TOKEN_TTL). Every API instance
// checks this Redis denylist instead. Entries only need to outlive the tokens they block.
const denyKey = (sessionId: string) => `auth:revoked-session:${sessionId}`;

export async function denylistSessions(sessionIds: string[]): Promise<void> {
  if (!sessionIds.length) return;
  try {
    const pipeline = redis.pipeline();
    for (const id of sessionIds) pipeline.set(denyKey(id), '1', 'EX', config.ACCESS_TOKEN_TTL_SECONDS);
    await pipeline.exec();
  } catch (err) {
    // The DB revocation already happened (no new tokens can be minted); only immediate
    // cut-off of already-issued access tokens is lost.
    logger.error({ err, sessionIds }, 'failed to denylist revoked sessions');
  }
}

export async function isSessionRevoked(sessionId: string): Promise<boolean> {
  try {
    return (await redis.exists(denyKey(sessionId))) === 1;
  } catch (err) {
    // Fail open: a Redis outage shouldn't take authentication down with it. The cost is
    // that tokens of just-revoked sessions keep working until they expire.
    logger.error({ err }, 'session denylist unavailable');
    return false;
  }
}

/** Find the session a refresh token belongs to (for logout), without rotating anything. */
export async function sessionForRefreshToken(token: string) {
  return db
    .selectFrom('refreshTokens as rt')
    .innerJoin('sessions as s', 's.id', 'rt.sessionId')
    .select(['s.id', 's.userId'])
    .where('rt.tokenHash', '=', hashToken(token))
    .executeTakeFirst();
}

export function listActiveSessions(userId: string) {
  return db
    .selectFrom('sessions')
    .select(['id', 'createdAt', 'lastUsedAt', 'userAgent', 'ip'])
    .where('userId', '=', userId)
    .where('revokedAt', 'is', null)
    .where('expiresAt', '>', new Date())
    .orderBy('lastUsedAt', 'desc')
    .execute();
}
