import { createHash } from 'node:crypto';
import { Counter } from 'prom-client';
import { afterCommit } from '../db/transaction.js';
import { logger } from './logger.js';
import { registry } from './metrics.js';
import { redis } from './redis.js';

/*
 * Two caches for two kinds of data.
 *
 * 1. MicroCache: in-process, ~1 second, for data that is HOT, BIG and CHANGES CONSTANTLY
 *    (a seat map during an on-sale). No invalidation at all: it expires before anyone
 *    notices, and live updates arrive over WebSockets anyway. Keeping it in-process means
 *    thousands of requests for one 100 KB seat map cost one database query per second per
 *    instance, and zero Redis bandwidth. Single-flight: when an entry expires under load,
 *    the concurrent misses share ONE load instead of stampeding the database.
 *
 * 2. Redis read-through with generation counters: shared by all instances, for data that is
 *    read a lot and CHANGES RARELY (event pages, listings). Correct invalidation is the hard
 *    part. Deleting the key after a write can race with a slow reader:
 *
 *        reader: GET miss → SELECT (old row) ………………………… SET key=old   ← stale for the whole TTL
 *        writer:                    UPDATE, COMMIT, DEL key
 *
 *    With generations, the key includes a counter (cache:event:42:<gen>). A write bumps the
 *    counter after commit. The slow reader above writes its stale value under the OLD
 *    generation, which nobody reads any more, so the race becomes harmless. Old entries
 *    simply expire.
 */

const cacheRequests = new Counter({
  name: 'cache_requests_total',
  help: 'Cache lookups by cache and result',
  labelNames: ['cache', 'result'] as const,
  registers: [registry],
});

export interface CachedBody {
  body: string;
  /** Weak ETag for conditional GETs (304 Not Modified). */
  etag: string;
}

export const etagOf = (body: string) => `W/"${createHash('sha1').update(body).digest('base64url')}"`;

export class MicroCache {
  private readonly entries = new Map<string, CachedBody & { expires: number; storedAt: number }>();
  private readonly inflight = new Map<string, Promise<CachedBody & { storedAt: number }>>();

  constructor(
    private readonly name: string,
    private readonly ttlMs: number,
    private readonly maxEntries = 500,
  ) {}

  async get(key: string, load: () => Promise<string>): Promise<CachedBody & { storedAt: number }> {
    const hit = this.entries.get(key);
    if (hit && hit.expires > Date.now()) {
      cacheRequests.inc({ cache: this.name, result: 'hit' });
      return hit;
    }
    const running = this.inflight.get(key);
    if (running) {
      cacheRequests.inc({ cache: this.name, result: 'coalesced' });
      return running;
    }

    cacheRequests.inc({ cache: this.name, result: 'miss' });
    const loading = load()
      .then((body) => {
        const entry = { body, etag: etagOf(body), storedAt: Date.now(), expires: Date.now() + this.ttlMs };
        this.entries.delete(key); // re-insert at the end: Map order doubles as LRU order
        this.entries.set(key, entry);
        if (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
        return entry;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, loading);
    return loading;
  }
}

export const generationKey = {
  event: (eventId: string) => `cache:gen:event:${eventId}`,
  eventLists: 'cache:gen:event-lists',
};

/**
 * Read-through Redis cache. The entry's key includes the current value of each generation
 * counter, so bumping any of them (invalidate()) makes the old entries unreachable.
 * If Redis is unavailable, falls through to the loader: slower, never wrong.
 */
export async function readThrough(
  cache: string,
  baseKey: string,
  generations: string[],
  ttlSeconds: number,
  load: () => Promise<string>,
): Promise<CachedBody> {
  let key: string | null;
  try {
    const gens = generations.length ? await redis.mget(...generations) : [];
    key = `cache:${baseKey}:${gens.map((g) => g ?? '0').join('.')}`;
    const hit = await redis.get(key);
    if (hit !== null) {
      cacheRequests.inc({ cache, result: 'hit' });
      return { body: hit, etag: etagOf(hit) };
    }
  } catch (err) {
    logger.warn({ err, cache }, 'cache unavailable; reading from the database');
    key = null;
  }

  cacheRequests.inc({ cache, result: 'miss' });
  const body = await load();
  if (key) redis.set(key, body, 'EX', ttlSeconds).catch(() => {});
  return { body, etag: etagOf(body) };
}

/** Bump generation counters now. */
export async function bumpGenerations(...generations: string[]): Promise<void> {
  const pipeline = redis.pipeline();
  for (const g of generations) pipeline.incr(g);
  await pipeline.exec();
}

/**
 * Bump generation counters once the current transaction commits. Bumping before commit
 * would let a reader cache the old data under the new generation.
 */
export function invalidate(...generations: string[]): void {
  afterCommit(() => bumpGenerations(...generations));
}
