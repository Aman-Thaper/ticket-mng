import { hostname } from 'node:os';
import { pino, stdSerializers, stdTimeFunctions } from 'pino';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';

export const INSTANCE_ID = config.INSTANCE_ID ?? `${hostname()}:${process.pid}`;

/**
 * One structured (JSON) logger for the whole process. Fastify uses it for request logs, and
 * code that runs outside a request (workers, startup, background tasks) imports it directly.
 *
 * Every line carries the instance and, for requests, the request id. That id also travels
 * into background jobs, so a single search in the log store follows one click through
 * Nginx, the API and every job it caused.
 */
export const logger = pino({
  level: config.NODE_ENV === 'test' ? 'silent' : config.LOG_LEVEL,
  base: { instance: INSTANCE_ID },
  timestamp: stdTimeFunctions.isoTime,
  // "level":"info" rather than "level":30: readable, and what log platforms expect.
  formatters: { level: (label) => ({ level: label }) },
  serializers: {
    req: (req: FastifyRequest) => ({
      method: req.method,
      url: req.url,
      route: req.routeOptions?.url,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    }),
    res: (res: FastifyReply) => ({ statusCode: res.statusCode }),
    err: stdSerializers.err,
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.newPassword',
      '*.currentPassword',
      '*.token',
      '*.clientSecret',
    ],
    censor: '[redacted]',
  },
  // Human-friendly output in development: LOG_PRETTY=true npm run dev
  ...(process.env.LOG_PRETTY === 'true'
    ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
    : {}),
});
