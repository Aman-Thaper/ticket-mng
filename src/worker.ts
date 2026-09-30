/**
 * The worker process: runs background jobs and relays the outbox. Same codebase as the API,
 * different entry point. Scale it independently (more workers for a big email backlog)
 * without touching the API tier.
 *
 *   npm run worker        # dev, restarts on change
 *   npm run start:worker  # production
 */
import { createServer } from 'node:http';
import { sql } from 'kysely';
import { config } from './config.js';
import { db } from './db/index.js';
import { handlers } from './jobs/handlers/index.js';
import { OutboxRelay } from './jobs/outbox.js';
import { closeQueues, DEAD_LETTER_QUEUE, getQueue, QUEUE_NAMES } from './jobs/queues.js';
import { createWorker } from './jobs/runner.js';
import { registerSchedules } from './jobs/schedules.js';
import { lifecycle } from './lib/lifecycle.js';
import { logger } from './lib/logger.js';
import { gaugeFrom, registry } from './lib/metrics.js';
import { redis } from './lib/redis.js';
import { ensureBucket } from './lib/storage.js';
import { readiness } from './modules/health/checks.js';

// Concurrency per queue reflects what each kind of job is bound by: email waits on SMTP
// (I/O, many in parallel), media burns CPU (few), maintenance scans tables (one at a time).
// Email providers rate-limit their APIs (Resend: 2 requests/s by default). Pacing the queue
// keeps a sold-out on-sale from turning into a burst of 429s and wasted retries.
const mailRate = config.MAIL_RATE_PER_SECOND ?? (config.MAIL_TRANSPORT === 'resend' ? 2 : undefined);

const workers = [
  createWorker('email', handlers.email, 10, mailRate ? { max: mailRate, duration: 1000 } : undefined),
  createWorker('bookings', handlers.bookings, 20),
  createWorker('payments', handlers.payments, 10),
  createWorker('media', handlers.media, 2),
  createWorker('maintenance', handlers.maintenance, 1),
];

// Queue depth and outbox backlog are global, so only the worker reports them (if every API
// instance did too, dashboards would count each queue several times). A growing "waiting"
// count means the workers can't keep up. A growing outbox age means the relay is stuck.
gaugeFrom('queue_jobs', 'Jobs per queue and state', ['queue', 'state'], async () => {
  const rows: Array<[Record<string, string>, number]> = [];
  for (const queue of [...QUEUE_NAMES, DEAD_LETTER_QUEUE] as const) {
    const counts = await getQueue(queue).getJobCounts('waiting', 'active', 'delayed', 'failed');
    for (const [state, n] of Object.entries(counts)) rows.push([{ queue, state }, n]);
  }
  return rows;
});
gaugeFrom(
  'outbox_unpublished',
  'Outbox rows not yet relayed to the queue, and the age of the oldest',
  ['measure'],
  async () => {
    const { rows } = await sql<{ count: number; oldest: number | null }>`
    SELECT count(*)::int AS count, extract(epoch FROM now() - min(created_at))::float8 AS oldest
    FROM outbox WHERE published_at IS NULL`.execute(db);
    return [
      [{ measure: 'rows' }, rows[0]?.count ?? 0],
      [{ measure: 'oldest_seconds' }, rows[0]?.oldest ?? 0],
    ];
  },
);

const relay = new OutboxRelay();
await relay.start();
await registerSchedules();
if (config.S3_AUTO_CREATE_BUCKET) {
  await ensureBucket().catch((err: unknown) => logger.warn({ err }, 'could not prepare the storage bucket'));
}

// A tiny HTTP server so orchestrators can probe the worker and Prometheus can scrape it.
const http = createServer((req, res) => {
  void (async () => {
    if (req.url === '/health/live') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
    } else if (req.url === '/health/ready' || req.url === '/health') {
      const { ready, checks } = await readiness();
      const running = workers.every((w) => w.isRunning());
      const ok = ready && running;
      res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          status: ok ? 'ok' : 'unavailable',
          checks: { ...checks, workers: running ? 'ok' : 'stopped' },
        }),
      );
    } else if (req.url === '/metrics') {
      if (config.METRICS_TOKEN && req.headers.authorization !== `Bearer ${config.METRICS_TOKEN}`) {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200, { 'content-type': registry.contentType }).end(await registry.metrics());
    } else {
      res.writeHead(404).end();
    }
  })().catch((err: unknown) => {
    logger.error({ err }, 'worker http error');
    if (!res.headersSent) res.writeHead(500).end();
  });
});
http.listen(config.WORKER_HTTP_PORT);
logger.info({ queues: workers.map((w) => w.name), port: config.WORKER_HTTP_PORT }, 'worker started');

// Graceful shutdown: stop taking new work, let in-flight jobs finish (worker.close waits for
// them), then close connections. A job cut off mid-way would be retried anyway (its lock
// expires and BullMQ re-queues it), but finishing it is cleaner.
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    lifecycle.beginShutdown();
    logger.info({ signal }, 'worker shutting down');
    void (async () => {
      await relay.stop();
      await Promise.allSettled(workers.map((w) => w.close()));
      http.close();
      await closeQueues();
      await Promise.allSettled([db.destroy(), redis.quit()]);
      process.exit(0);
    })();
  });
}
