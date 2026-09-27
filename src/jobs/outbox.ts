import { sql, type Kysely, type Transaction } from 'kysely';
import pg from 'pg';
import { config } from '../config.js';
import { withTransaction } from '../db/transaction.js';
import type { DB } from '../db/types.js';
import { currentRequestId } from '../lib/context.js';
import { logger } from '../lib/logger.js';
import { getQueue, type JobData, type JobName, type QueueName } from './queues.js';

type Conn = Kysely<DB> | Transaction<DB>;

export interface EnqueueOptions {
  /** Dedupe key: at most one job with this id exists in the queue at a time. */
  jobId?: string;
  /** Run no earlier than this (delayed job). */
  runAt?: Date;
}

/**
 * Schedule a background job as part of the caller's transaction. Nothing reaches the queue
 * unless the transaction commits; once it commits, the job is guaranteed to be published.
 */
export async function enqueue<Q extends QueueName, N extends JobName<Q>>(
  conn: Conn,
  queue: Q,
  name: N,
  data: JobData<Q, N>,
  opts: EnqueueOptions = {},
): Promise<void> {
  await conn
    .insertInto('outbox')
    .values({
      queue,
      jobName: name,
      payload: JSON.stringify(data),
      jobId: opts.jobId ?? null,
      runAt: opts.runAt ?? sql<Date>`now()`,
      requestId: currentRequestId() ?? null,
    })
    .execute();
}

const BATCH = 200;

/**
 * Move up to BATCH committed outbox rows into BullMQ. Returns how many were published.
 *
 * FOR UPDATE SKIP LOCKED lets several relays (several worker processes) run in parallel
 * without publishing the same row twice. If Redis fails, the transaction rolls back and the
 * rows are retried on the next pass. If we crash after publishing but before commit, the rows
 * are published again, and the fixed jobId makes BullMQ ignore the duplicates.
 */
export async function publishOutboxBatch(): Promise<number> {
  return withTransaction(
    async (trx) => {
      const rows = await trx
        .selectFrom('outbox')
        .selectAll()
        .where('publishedAt', 'is', null)
        .orderBy('id')
        .limit(BATCH)
        .forUpdate()
        .skipLocked()
        .execute();
      if (!rows.length) return 0;

      const now = Date.now();
      const byQueue = new Map<string, typeof rows>();
      for (const row of rows) byQueue.set(row.queue, [...(byQueue.get(row.queue) ?? []), row]);

      for (const [queue, items] of byQueue) {
        await getQueue(queue as QueueName).addBulk(
          items.map((r) => ({
            name: r.jobName,
            data: { ...r.payload, _meta: { requestId: r.requestId, outboxId: r.id } },
            opts: { jobId: r.jobId ?? `outbox-${r.id}`, delay: Math.max(0, r.runAt.getTime() - now) },
          })),
        );
      }

      await trx
        .updateTable('outbox')
        .set({ publishedAt: new Date() })
        .where(
          'id',
          'in',
          rows.map((r) => r.id),
        )
        .execute();
      return rows.length;
    },
    { retries: 0 },
  );
}

/**
 * Runs in the worker process. Publishes as soon as Postgres NOTIFYs about new rows, and polls
 * every few seconds in case a notification was missed (listener reconnecting, NOTIFY queue
 * overflow). Overlapping triggers coalesce into one drain loop.
 */
export class OutboxRelay {
  private listener: pg.Client | null = null;
  private poll: NodeJS.Timeout | null = null;
  private draining: Promise<void> | null = null;
  private again = false;
  private stopped = false;

  constructor(private readonly pollMs = 2_000) {}

  async start(): Promise<void> {
    await this.listen();
    this.poll = setInterval(() => this.trigger(), this.pollMs);
    this.trigger();
  }

  trigger(): void {
    if (this.stopped) return;
    if (this.draining) {
      this.again = true;
      return;
    }
    this.draining = this.drain().finally(() => {
      this.draining = null;
    });
  }

  private async drain(): Promise<void> {
    try {
      do {
        this.again = false;
        let published: number;
        do {
          published = await publishOutboxBatch();
          if (published) logger.debug({ published }, 'outbox relayed');
        } while (published > 0 && !this.stopped);
      } while (this.again && !this.stopped);
    } catch (err) {
      logger.error({ err }, 'outbox relay failed; will retry on the next trigger');
    }
  }

  private async listen(): Promise<void> {
    const client = new pg.Client({ connectionString: config.DATABASE_URL });
    client.on('notification', () => this.trigger());
    client.on('error', (err) => {
      logger.warn({ err }, 'outbox listener lost its connection; reconnecting');
      this.listener = null;
      setTimeout(() => {
        if (!this.stopped)
          this.listen().catch((e: unknown) => logger.error({ err: e }, 'outbox listener reconnect failed'));
      }, 1_000);
    });
    await client.connect();
    await client.query('LISTEN outbox');
    this.listener = client;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.poll) clearInterval(this.poll);
    await this.draining;
    await this.listener?.end().catch(() => {});
  }
}
