import { z } from 'zod';
import type { FastifyReply } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { config } from '../../config.js';
import { AppError } from '../../lib/errors.js';
import { registry } from '../../lib/metrics.js';
import { readiness } from './checks.js';

const Ready = z.object({ status: z.enum(['ok', 'unavailable']), checks: z.record(z.string(), z.string()) });

async function answerReadiness(reply: FastifyReply) {
  const { ready, checks } = await readiness();
  return reply.status(ready ? 200 : 503).send({ status: ready ? 'ok' : 'unavailable', checks });
}

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  // Liveness: can the process answer at all? No dependency checks, so a database outage
  // doesn't make an orchestrator restart every API container in a loop.
  app.get(
    '/health/live',
    {
      schema: {
        tags: ['ops'],
        summary: 'Liveness probe',
        response: { 200: z.object({ status: z.literal('ok') }) },
      },
    },
    async () => ({ status: 'ok' as const }),
  );

  // Readiness: should traffic be routed here? Database and Redis reachable, and not
  // shutting down. It fails during graceful shutdown, so the load balancer drains this
  // instance before it closes.
  app.get(
    '/health/ready',
    {
      schema: {
        tags: ['ops'],
        summary: 'Readiness probe (database, Redis, lifecycle)',
        response: { 200: Ready, 503: Ready },
      },
    },
    async (_req, reply) => answerReadiness(reply),
  );
  app.get(
    '/health',
    { schema: { tags: ['ops'], summary: 'Alias of /health/ready', response: { 200: Ready, 503: Ready } } },
    async (_req, reply) => answerReadiness(reply),
  );

  // Prometheus scrape endpoint. Keep it off the public internet: Nginx refuses it, and
  // METRICS_TOKEN (if set) also requires "Authorization: Bearer <token>".
  app.get('/metrics', { schema: { hide: true } }, async (req, reply) => {
    if (config.METRICS_TOKEN && req.headers.authorization !== `Bearer ${config.METRICS_TOKEN}`) {
      throw new AppError(401, 'UNAUTHENTICATED', 'Metrics require a token');
    }
    return reply.type(registry.contentType).send(await registry.metrics());
  });
};
