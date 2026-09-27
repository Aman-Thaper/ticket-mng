import { UnrecoverableError, Worker, type Job } from 'bullmq';
import type { Logger } from 'pino';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { DEAD_LETTER_QUEUE, getQueue, redisConnection, type JobMeta, type QueueName } from './queues.js';

export type JobHandler<T = unknown> = (job: Job<T & JobMeta>, log: Logger) => Promise<unknown>;

/** What a dead letter records about the job that died. */
export interface DeadLetter {
  queue: string;
  name: string;
  data: unknown;
  originalJobId: string | undefined;
  error: string;
  stack: string | undefined;
  attemptsMade: number;
  failedAt: string;
}

/** True once BullMQ won't retry: attempts used up, or the handler declared the error permanent. */
export function isFinalFailure(job: Job, err: Error): boolean {
  return (
    err instanceof UnrecoverableError ||
    err.name === 'UnrecoverableError' ||
    job.attemptsMade >= (job.opts.attempts ?? 1)
  );
}

/**
 * Dead-letter queue: jobs that failed for good land here with their error, and nothing
 * consumes the queue, so they wait for a human (GET /admin/dead-letters) to inspect them
 * and retry or discard. Failures that retries can't fix, like a bug or a bad payload, end
 * up visible in one place instead of silently disappearing.
 */
export async function sendToDeadLetter(job: Job, err: Error): Promise<void> {
  const letter: DeadLetter = {
    queue: job.queueName,
    name: job.name,
    data: job.data,
    originalJobId: job.id,
    error: err.message,
    stack: err.stack?.split('\n').slice(0, 12).join('\n'),
    attemptsMade: job.attemptsMade,
    failedAt: new Date().toISOString(),
  };
  await getQueue(DEAD_LETTER_QUEUE).add('dead-letter', letter, {
    jobId: `${job.queueName}-${job.id}`,
    attempts: 1,
    removeOnComplete: false,
    removeOnFail: false,
  });
}

/**
 * A BullMQ worker that dispatches by job name, logs every job with its correlation ids, and
 * sends jobs that failed for good to the dead-letter queue.
 */
export function createWorker(
  queue: QueueName,
  handlers: Record<string, JobHandler<never>>,
  concurrency: number,
) {
  const worker = new Worker(
    queue,
    async (job: Job<JobMeta>) => {
      const handler = handlers[job.name] as JobHandler | undefined;
      if (!handler) throw new UnrecoverableError(`No handler for ${queue}/${job.name}`);

      const log = logger.child({
        queue,
        job: job.name,
        jobId: job.id,
        attempt: job.attemptsMade + 1,
        requestId: job.data._meta?.requestId ?? undefined,
      });
      const started = performance.now();
      try {
        const result = await handler(job, log);
        log.info({ ms: Math.round(performance.now() - started) }, 'job completed');
        return result;
      } catch (err) {
        log.warn({ err, ms: Math.round(performance.now() - started) }, 'job failed');
        throw err;
      }
    },
    { connection: redisConnection(), prefix: config.QUEUE_PREFIX, concurrency },
  );

  worker.on('failed', (job, err) => {
    if (!job || !isFinalFailure(job, err)) return;
    sendToDeadLetter(job, err).catch((dlqErr: unknown) =>
      logger.error({ err: dlqErr, queue, jobId: job.id }, 'failed to dead-letter a job'),
    );
  });
  worker.on('error', (err) => logger.error({ err, queue }, 'worker error'));
  return worker;
}
