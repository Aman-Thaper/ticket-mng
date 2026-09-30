import { Queue, type ConnectionOptions, type JobsOptions } from 'bullmq';
import { config } from '../config.js';

/**
 * Every background job, by queue and name, with its payload. Payloads carry ids only. Handlers
 * re-read current state from the database, because by the time a job runs (seconds, minutes,
 * or a 10-minute delay later) the data may have changed.
 */
export interface Jobs {
  email: {
    'password-reset': { email: string };
    'verify-email': { userId: string };
    'booking-confirmed': { bookingId: string };
    'event-reminder': { bookingId: string };
    'refund-processed': { refundId: string };
  };
  payments: {
    'process-webhook': { provider: string; eventId: string };
    refund: { refundId: string };
    'refund-event': { eventId: string };
  };
  bookings: {
    'expire-booking': { bookingId: string };
    'sweep-expired-holds': Record<string, never>;
  };
  media: {
    'process-poster': { eventId: string; key: string };
  };
  maintenance: {
    'send-event-reminders': Record<string, never>;
    cleanup: Record<string, never>;
  };
}

export type QueueName = keyof Jobs;
export type JobName<Q extends QueueName> = Extract<keyof Jobs[Q], string>;
export type JobData<Q extends QueueName, N extends JobName<Q>> = Jobs[Q][N];

export const QUEUE_NAMES = [
  'email',
  'bookings',
  'payments',
  'media',
  'maintenance',
] as const satisfies readonly QueueName[];
export const DEAD_LETTER_QUEUE = 'dead-letter';

/** Metadata the outbox relay attaches to every job. */
export interface JobMeta {
  _meta?: { requestId?: string | null; outboxId?: number };
}

/**
 * BullMQ opens its own Redis connections (workers need blocking ones), so it gets
 * connection options rather than our shared client.
 */
export function redisConnection(): ConnectionOptions {
  const url = new URL(config.REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    db: Number(url.pathname.slice(1) || 0),
    username: url.username || undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

/**
 * Retry policy: 5 attempts, exponential backoff with jitter (≈2s, 4s, 8s, 16s, each ±50%).
 * Jitter keeps a burst of jobs that failed together (say, the SMTP server blipped) from
 * retrying in lockstep and knocking it over again.
 *
 * Completed jobs are kept for a day. A job id stays reserved while its job exists, which
 * makes re-publishing the same outbox row within that window a no-op.
 */
export const defaultJobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000, jitter: 0.5 },
  removeOnComplete: { age: 24 * 3600, count: 50_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

const queues = new Map<string, Queue>();

export function getQueue(name: QueueName | typeof DEAD_LETTER_QUEUE): Queue {
  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue(name, {
      connection: redisConnection(),
      prefix: config.QUEUE_PREFIX,
      defaultJobOptions,
    });
    queues.set(name, queue);
  }
  return queue;
}

export async function closeQueues(): Promise<void> {
  const all = [...queues.values()];
  queues.clear();
  await Promise.all(all.map((q) => q.close()));
}
