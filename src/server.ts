import { config } from './config.js';
import { buildApp } from './app.js';
import { db } from './db/index.js';
import { logger } from './lib/logger.js';
import { redis } from './lib/redis.js';
import { ensureBucket } from './lib/storage.js';
import { closeQueues } from './jobs/queues.js';

const app = await buildApp({ loggerInstance: logger });

async function closeResources() {
  await closeQueues();
  await Promise.allSettled([db.destroy(), redis.quit()]);
}

// Graceful shutdown: stop accepting connections, let in-flight requests finish, then close
// the database pool and Redis connection.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    void app
      .close()
      .then(closeResources)
      .then(() => process.exit(0));
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
