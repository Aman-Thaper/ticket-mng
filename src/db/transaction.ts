import { setTimeout as sleep } from 'node:timers/promises';
import type { Transaction } from 'kysely';
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

/**
 * Run `fn` in a transaction, retrying the whole transaction on serialization failures and
 * deadlocks. Postgres rolled the failed attempt back completely, so a retry starts from a
 * clean slate.
 *
 * `fn` must be safe to run more than once: no side effects outside the transaction
 * (emails, HTTP calls) inside it.
 */
export async function withTransaction<T>(
  fn: (trx: Transaction<DB>) => Promise<T>,
  { isolation = 'read committed', retries = 3 }: TransactionOptions = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction().setIsolationLevel(isolation).execute(fn);
    } catch (err) {
      if (!isRetryable(err) || attempt >= retries) throw err;
      // Jittered exponential backoff so the retrying transactions don't collide again in lockstep.
      await sleep(Math.random() * 10 * 2 ** attempt);
    }
  }
}
