import { z } from 'zod';
import { sql } from 'kysely';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { db } from '../../db/index.js';

// Phase 7 splits this into liveness and readiness checks.
export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/health',
    {
      schema: {
        tags: ['ops'],
        summary: 'Health check (includes a database ping)',
        response: {
          200: z.object({ status: z.literal('ok') }),
          503: z.object({ status: z.literal('unavailable') }),
        },
      },
    },
    async (req, reply) => {
      try {
        await sql`SELECT 1`.execute(db);
        return { status: 'ok' as const };
      } catch (err) {
        req.log.error({ err }, 'health check: database unreachable');
        return reply.status(503).send({ status: 'unavailable' as const });
      }
    },
  );
};
