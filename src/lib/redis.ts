import { Redis, type RedisOptions } from 'ioredis';
import { config } from '../config.js';

/**
 * Shared connection for regular commands (cache, rate limits, denylist, pub/sub publish).
 * Commands sent in the same tick are pipelined automatically, so hot paths that issue
 * several commands share one network round trip.
 *
 * Blocking commands and SUBSCRIBE need their own connections (see createRedis).
 */
export function createRedis(options: RedisOptions = {}) {
  return new Redis(config.REDIS_URL, {
    enableAutoPipelining: true,
    maxRetriesPerRequest: 2,
    ...options,
  });
}

export const redis = createRedis();
