/**
 * The worker process: runs background jobs and relays the outbox. Same codebase as the API,
 * different entry point. Scale it independently (more workers for a big email backlog)
 * without touching the API tier.
 *
 *   npm run worker        # dev, restarts on change
 *   npm run start:worker  # production
 */
import { config } from './config.js';
import { db } from './db/index.js';
import { handlers } from './jobs/handlers/index.js';
import { OutboxRelay } from './jobs/outbox.js';
import { closeQueues } from './jobs/queues.js';
import { createWorker } from './jobs/runner.js';
import { registerSchedules } from './jobs/schedules.js';
import { logger } from './lib/logger.js';
import { redis } from './lib/redis.js';
import { ensureBucket } from './lib/storage.js';

// Concurrency per queue reflects what each kind of job is bound by: email waits on SMTP
// (I/O, many in parallel), media burns CPU (few), maintenance scans tables (one at a time).
const workers = [
  createWorker('email', handlers.email, 10),
  createWorker('bookings', handlers.bookings, 20),
  createWorker('media', handlers.media, 2),
  createWorker('maintenance', handlers.maintenance, 1),
];

const relay = new OutboxRelay();
await relay.start();
await registerSchedules();
if (config.S3_AUTO_CREATE_BUCKET) {
  await ensureBucket().catch((err: unknown) => logger.warn({ err }, 'could not prepare the storage bucket'));
}
logger.info({ queues: workers.map((w) => w.name) }, 'worker started');

// Graceful shutdown: stop taking new work, let in-flight jobs finish (worker.close waits for
// them), then close connections. A job cut off mid-way would be retried anyway (its lock
// expires and BullMQ re-queues it), but finishing it is cleaner.
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'worker shutting down');
    void (async () => {
      await relay.stop();
      await Promise.allSettled(workers.map((w) => w.close()));
      await closeQueues();
      await Promise.allSettled([db.destroy(), redis.quit()]);
      process.exit(0);
    })();
  });
}
