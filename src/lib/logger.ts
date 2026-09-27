import { pino } from 'pino';
import { config } from '../config.js';

/**
 * One structured (JSON) logger for the whole process. Fastify uses it for request logs, and
 * code that runs outside a request (workers, startup, background tasks) imports it directly.
 * Credentials are redacted before anything is written.
 */
export const logger = pino({
  level: config.NODE_ENV === 'test' ? 'silent' : config.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.newPassword',
      '*.currentPassword',
      '*.token',
    ],
    censor: '[redacted]',
  },
});
