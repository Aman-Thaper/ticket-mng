import { randomUUID } from 'node:crypto';
import type { Result } from 'ioredis';
import { logger } from '../../lib/logger.js';
import { redis } from '../../lib/redis.js';

/**
 * The claim gate: a Redis fast path in front of the booking transaction.
 *
 * When 200 people click the same seat in the same second, only one can win. Without the
 * gate, all 200 open a Postgres transaction, take a pool connection, and lock or skip
 * rows before 199 of them give up. With the gate, each attempt first claims its seats in
 * Redis (SET NX, a few seconds TTL). 199 of the 200 learn in ~0.1 ms that someone else
 * is mid-booking and get a 409 without touching Postgres at all.
 *
 * This is a load shield, NOT the correctness mechanism. A TTL lock in Redis can't
 * guarantee mutual exclusion: the key can expire while its owner is still working, a
 * failover can lose it, and the process can pause. The database transaction still decides
 * who gets the seat. If Redis is down, the gate is skipped and Postgres handles everything.
 */

const CLAIM_TTL_MS = 5_000;

// Claim every key or none. Keys are only ever deleted by the token that set them, so an
// attempt can never release a claim that expired and was re-taken by someone else.
const CLAIM = `
for i, key in ipairs(KEYS) do
  if not redis.call('SET', key, ARGV[1], 'NX', 'PX', ARGV[2]) then
    for j = 1, i - 1 do
      if redis.call('GET', KEYS[j]) == ARGV[1] then redis.call('DEL', KEYS[j]) end
    end
    return i
  end
end
return 0
`;

const RELEASE = `
for _, key in ipairs(KEYS) do
  if redis.call('GET', key) == ARGV[1] then redis.call('DEL', key) end
end
return 0
`;

// Defined without a fixed key count, so the first argument of each call is the number of
// keys. ioredis sends EVALSHA and only falls back to the full script if Redis hasn't cached it.
declare module 'ioredis' {
  interface RedisCommander<Context> {
    claimSeats(numKeys: number, ...keysThenArgs: Array<string | number>): Result<number, Context>;
    releaseSeats(numKeys: number, ...keysThenArgs: string[]): Result<number, Context>;
  }
}
redis.defineCommand('claimSeats', { lua: CLAIM });
redis.defineCommand('releaseSeats', { lua: RELEASE });

// The {eventId} hash tag puts all of an event's claim keys in the same Redis Cluster slot,
// which a multi-key Lua script requires.
const claimKey = (eventId: string, seatId: number) => `claim:{${eventId}}:${seatId}`;

export type ClaimResult =
  { ok: true; release: () => Promise<void> } | { ok: false; conflictingSeatId: number };

const noop = async () => {};

export async function claimSeats(eventId: string, seatIds: number[]): Promise<ClaimResult> {
  const keys = seatIds.map((id) => claimKey(eventId, id));
  const token = randomUUID();
  try {
    const conflictIndex = await redis.claimSeats(keys.length, ...keys, token, CLAIM_TTL_MS);
    if (conflictIndex !== 0) return { ok: false, conflictingSeatId: seatIds[conflictIndex - 1]! };
  } catch (err) {
    logger.warn({ err }, 'claim gate unavailable; falling through to the database');
    return { ok: true, release: noop };
  }

  return {
    ok: true,
    release: async () => {
      try {
        await redis.releaseSeats(keys.length, ...keys, token);
      } catch (err) {
        logger.warn({ err }, 'failed to release seat claims (they expire on their own)');
      }
    },
  };
}
