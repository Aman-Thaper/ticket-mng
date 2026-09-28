import { setTimeout as sleep } from 'node:timers/promises';
import { config } from './config.js';
import { buildApp } from './app.js';
import { db } from './db/index.js';
import { closeQueues } from './jobs/queues.js';
import { lifecycle } from './lib/lifecycle.js';
import { logger } from './lib/logger.js';
import { redis } from './lib/redis.js';
import { ensureBucket } from './lib/storage.js';

const app = await buildApp({ loggerInstance: logger });

async function closeResources() {
  await closeQueues();
  await Promise.allSettled([db.destroy(), redis.quit()]);
}

// Graceful shutdown, in order:
//   1. report not-ready (/health/ready → 503) so the load balancer stops sending traffic;
//   2. wait SHUTDOWN_DRAIN_MS for it to notice;
//   3. stop accepting connections, finish in-flight requests, tell WebSocket clients to
//      reconnect elsewhere (close code 1001);
//   4. close the database pool and Redis.
// Rolling deploys therefore drop no requests.
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, 'shutting down');
    lifecycle.beginShutdown();
    void (async () => {
      if (config.SHUTDOWN_DRAIN_MS) await sleep(config.SHUTDOWN_DRAIN_MS);
      await app.close();
      await closeResources();
      process.exit(0);
    })();
  });
}

if (config.S3_AUTO_CREATE_BUCKET) {
  // Presigned uploads need the bucket to exist. Not fatal: only poster uploads depend on it.
  await ensureBucket().catch((err: unknown) => logger.warn({ err }, 'could not prepare the storage bucket'));
}

try {
  await app.listen({ host: config.HOST, port: config.PORT });
  app.log.info(`API docs at http://localhost:${config.PORT}/docs`);
} catch (err) {
  app.log.error(err);
  await closeResources();
  process.exit(1);
}
