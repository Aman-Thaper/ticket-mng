import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../db/index.js';
import { AppError } from './errors.js';

/*
 * Idempotency-Key, Stripe style. A client that times out doesn't know whether its POST went
 * through. With a key, it can simply send the same request again:
 *
 *   first request      → runs, and its response is stored under (user, key)
 *   retry, same body   → the stored response is replayed (Idempotent-Replayed: true)
 *   concurrent retry   → 409 IDEMPOTENCY_REQUEST_IN_PROGRESS (Retry-After: 1)
 *   same key, new body → 422: keys identify one specific request
 *   request failed     → the key is released so the client can retry for real
 *
 * The key is claimed with an INSERT before the handler runs, so two concurrent requests
 * with the same key can never both execute. If a process dies mid-request, its claim is
 * taken over after STALE_MS.
 */

const STALE_MS = 60_000;

/** JSON with sorted keys, so {a,b} and {b,a} hash the same. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export interface HandlerResult<T> {
  statusCode: number;
  body: T;
}

export async function withIdempotency<T>(
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  handler: () => Promise<HandlerResult<T>>,
): Promise<T> {
  const header = req.headers['idempotency-key'];
  if (header === undefined) {
    const result = await handler();
    reply.status(result.statusCode);
    return result.body;
  }

  const key = Array.isArray(header) ? header[0] : header;
  if (!key || key.length > 255 || !/^[\x21-\x7e]+$/.test(key)) {
    throw new AppError(
      400,
      'INVALID_IDEMPOTENCY_KEY',
      'Idempotency-Key must be 1-255 printable ASCII characters',
    );
  }
  const requestHash = createHash('sha256')
    .update(
      `${req.method} ${req.routeOptions.url}\n${stableStringify(req.params)}\n${stableStringify(req.body)}`,
    )
    .digest('hex');
  const where = { userId, key };

  const claimed = await db
    .insertInto('idempotencyKeys')
    .values({ ...where, requestHash })
    .onConflict((oc) => oc.columns(['userId', 'key']).doNothing())
    .returning('key')
    .executeTakeFirst();

  if (!claimed) {
    const existing = await db
      .selectFrom('idempotencyKeys')
      .selectAll()
      .where('userId', '=', userId)
      .where('key', '=', key)
      .executeTakeFirstOrThrow();
    if (existing.requestHash !== requestHash) {
      throw new AppError(
        422,
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used for a different request',
      );
    }
    if (existing.responseStatus !== null) {
      reply.header('idempotent-replayed', 'true').status(existing.responseStatus);
      return existing.responseBody as T; // stored from an earlier successful T
    }
    // Still running, or abandoned by a crashed process: take over only if it's stale.
    const takenOver = await db
      .updateTable('idempotencyKeys')
      .set({ createdAt: new Date() })
      .where('userId', '=', userId)
      .where('key', '=', key)
      .where('responseStatus', 'is', null)
      .where('createdAt', '<', new Date(Date.now() - STALE_MS))
      .returning('key')
      .executeTakeFirst();
    if (!takenOver) {
      reply.header('retry-after', 1);
      throw new AppError(
        409,
        'IDEMPOTENCY_REQUEST_IN_PROGRESS',
        'A request with this Idempotency-Key is still in progress',
      );
    }
  }

  try {
    const result = await handler();
    await db
      .updateTable('idempotencyKeys')
      .set({ responseStatus: result.statusCode, responseBody: JSON.stringify(result.body) })
      .where('userId', '=', userId)
      .where('key', '=', key)
      .execute();
    reply.status(result.statusCode);
    return result.body;
  } catch (err) {
    // Errors aren't stored: the request didn't happen, so the client may retry it.
    await db
      .deleteFrom('idempotencyKeys')
      .where('userId', '=', userId)
      .where('key', '=', key)
      .where('responseStatus', 'is', null)
      .execute();
    throw err;
  }
}
