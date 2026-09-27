import { config } from './config.js';
import { buildApp } from './app.js';
import { db } from './db/index.js';

const app = await buildApp({
  logger: { level: config.LOG_LEVEL },
});

// Graceful shutdown: stop accepting connections, let in-flight requests finish, close the pool.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await db.destroy();
    process.exit(0);
  });
}

try {
  await app.listen({ host: config.HOST, port: config.PORT });
  app.log.info(`API docs at http://localhost:${config.PORT}/docs`);
} catch (err) {
  app.log.error(err);
  await db.destroy();
  process.exit(1);
}
