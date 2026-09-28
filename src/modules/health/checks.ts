import { sql } from 'kysely';
import { db } from '../../db/index.js';
import { lifecycle } from '../../lib/lifecycle.js';
import { redis } from '../../lib/redis.js';

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)),
  ]);

export interface Readiness {
  ready: boolean;
  checks: Record<string, string>;
}

/** Can this process do useful work right now? Shared by the API and the worker. */
export async function readiness(): Promise<Readiness> {
  const [database, cache] = await Promise.allSettled([
    withTimeout(sql`SELECT 1`.execute(db), 1_000),
    withTimeout(redis.ping(), 1_000),
  ]);
  const checks = {
    database: database.status === 'fulfilled' ? 'ok' : String(database.reason),
    redis: cache.status === 'fulfilled' ? 'ok' : String(cache.reason),
    lifecycle: lifecycle.shuttingDown ? 'shutting down' : 'ok',
  };
  return { ready: Object.values(checks).every((c) => c === 'ok'), checks };
}
