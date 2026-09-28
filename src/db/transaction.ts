import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Transaction } from 'kysely';
import { logger } from '../lib/logger.js';
import { db } from './index.js';
import type { DB } from './types.js';

/** Postgres errors that mean "nothing is wrong with your request, just run it again". */
const RETRYABLE = new Set([
  '40001', // serialization_failure: SERIALIZABLE/REPEATABLE READ detected a conflicting concurrent transaction
  '40P01', // deadlock_detected: the deadlock detector chose this transaction as the victim
]);

export function isRetryable(err: unknown): boolean {
  return typeof err === 'object' && err !== null && RETRYABLE.has((err as { code?: string }).code ?? '');
}

export interface TransactionOptions {
  isolation?: 'read committed' | 'repeatable read' | 'serializable';
  /** Extra attempts after the first one fails with a retryable error. */
  retries?: number;
}

type Effect = () => unknown;
const pendingEffects = new AsyncLocalStorage<Effect[]>();

/**
 * Run `effect` once the surrounding transaction has committed, never if it rolls back.
 *
 * For side effects that are best-effort and must not be seen before the data is: pushing
 * live seat updates, invalidating caches. (Anything that MUST happen goes in the
 * transactional outbox instead.) Outside a transaction the effect runs straight away.
 */
export function afterCommit(effect: Effect): void {
  const effects = pendingEffects.getStore();
  if (effects) effects.push(effect);
  else void runEffects([effect]);
}

/** Effects are best-effort: a failure is logged, never thrown into the committed request. */
async function runEffects(effects: Effect[]): Promise<void> {
  for (const effect of effects) {
    try {
      await effect();
    } catch (err) {
      logger.warn({ err }, 'after-commit effect failed');
    }
  }
}

/**
 * Run `fn` in a transaction, retrying the whole transaction on serialization failures and
 * deadlocks. Postgres rolled the failed attempt back completely, so a retry starts from a
 * clean slate, and so do its afterCommit effects: only the attempt that commits fires them.
 *
 * `fn` must be safe to run more than once: no side effects outside the transaction
 * (emails, HTTP calls) inside it. Use afterCommit() or the outbox for those.
 */
export async function withTransaction<T>(
  fn: (trx: Transaction<DB>) => Promise<T>,
  { isolation = 'read committed', retries = 3 }: TransactionOptions = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const effects: Effect[] = [];
    try {
      const result = await pendingEffects.run(effects, () =>
        db.transaction().setIsolationLevel(isolation).execute(fn),
      );
      // Awaited, so that when withTransaction returns, caches are already invalidated and
      // updates broadcast: a handler that reads right after its own write sees fresh data.
      await runEffects(effects);
      return result;
    } catch (err) {
      if (!isRetryable(err) || attempt >= retries) throw err;
      // Jittered exponential backoff so the retrying transactions don't collide again in lockstep.
      await sleep(Math.random() * 10 * 2 ** attempt);
    }
  }
}
