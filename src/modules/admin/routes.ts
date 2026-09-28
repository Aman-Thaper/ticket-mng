import { z } from 'zod';
import { sql } from 'kysely';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { db } from '../../db/index.js';
import { DEAD_LETTER_QUEUE, getQueue, QUEUE_NAMES, type QueueName } from '../../jobs/queues.js';
import type { DeadLetter } from '../../jobs/runner.js';
import { notFound } from '../../lib/errors.js';
import { checkInvariants, INVARIANT_NAMES } from '../../lib/invariants.js';
import { errors, Limit } from '../../lib/schemas.js';
import { bearerAuth, requireRole } from '../auth/guard.js';

const JOB_STATES = ['waiting', 'active', 'delayed', 'completed', 'failed', 'prioritized'] as const;

const DeadLetterDto = z.object({
  id: z.string(),
  queue: z.string(),
  name: z.string(),
  error: z.string(),
  attemptsMade: z.int(),
  failedAt: z.string(),
  data: z.unknown(),
});

const DeadLetterParams = z.object({ id: z.string().min(1).max(300) });

export const adminRoutes: FastifyPluginAsyncZod = async (app) => {
  // Every route in this plugin is admin-only.
  app.addHook('onRequest', requireRole('admin'));

  app.get(
    '/admin/queues',
    {
      schema: {
        tags: ['admin'],
        summary: 'Job queue depths, dead letters and outbox backlog',
        security: bearerAuth,
        response: {
          200: z.object({
            queues: z.array(z.object({ name: z.string(), counts: z.record(z.string(), z.number()) })),
            outbox: z.object({ unpublished: z.int(), oldestSeconds: z.number().nullable() }),
          }),
          ...errors,
        },
      },
    },
    async () => {
      const names = [...QUEUE_NAMES, DEAD_LETTER_QUEUE] as const;
      const queues = await Promise.all(
        names.map(async (name) => ({ name, counts: await getQueue(name).getJobCounts(...JOB_STATES) })),
      );
      // A growing, aging backlog means the relay is down or can't reach Redis.
      const outbox = await db
        .selectFrom('outbox')
        .select((eb) => [
          eb.fn.countAll<number>().as('unpublished'),
          sql<number | null>`extract(epoch FROM now() - min(created_at))::float8`.as('oldestSeconds'),
        ])
        .where('publishedAt', 'is', null)
        .executeTakeFirstOrThrow();
      return { queues, outbox };
    },
  );

  app.get(
    '/admin/invariants',
    {
      schema: {
        tags: ['admin'],
        summary: 'Audit the business rules (no seat sold twice, no money kept for nothing, ...)',
        description:
          'Runs one query per rule over the whole database, so it can take a while on a big one: ' +
          'run it after incidents, deploys or load tests, not on a schedule.',
        security: bearerAuth,
        response: {
          200: z.object({
            ok: z.boolean(),
            checked: z.array(z.string()),
            violations: z.array(
              z.object({
                name: z.string(),
                description: z.string(),
                count: z.int(),
                sample: z.array(z.unknown()),
              }),
            ),
          }),
          ...errors,
        },
      },
    },
    async () => {
      const violations = await checkInvariants(db);
      if (violations.length) app.log.error({ violations }, 'business invariants violated');
      return { ok: violations.length === 0, checked: INVARIANT_NAMES, violations };
    },
  );

  app.get(
    '/admin/dead-letters',
    {
      schema: {
        tags: ['admin'],
        summary: 'Jobs that failed permanently',
        security: bearerAuth,
        querystring: z.object({ limit: Limit }),
        response: { 200: z.array(DeadLetterDto), ...errors },
      },
    },
    async (req) => {
      const jobs = await getQueue(DEAD_LETTER_QUEUE).getJobs(['waiting'], 0, req.query.limit - 1);
      return jobs.map((job) => {
        const letter = job.data as DeadLetter;
        return {
          id: job.id!,
          queue: letter.queue,
          name: letter.name,
          error: letter.error,
          attemptsMade: letter.attemptsMade,
          failedAt: letter.failedAt,
          data: letter.data,
        };
      });
    },
  );

  app.post(
    '/admin/dead-letters/:id/retry',
    {
      schema: {
        tags: ['admin'],
        summary: 'Put a dead job back on its original queue',
        security: bearerAuth,
        params: DeadLetterParams,
        response: { 202: z.object({ requeuedAs: z.string() }), ...errors },
      },
    },
    async (req, reply) => {
      const dlq = getQueue(DEAD_LETTER_QUEUE);
      const job = await dlq.getJob(req.params.id);
      if (!job) throw notFound('Dead letter');
      const letter = job.data as DeadLetter;
      const requeued = await getQueue(letter.queue as QueueName).add(letter.name, letter.data, {
        jobId: `retry-${Date.now()}-${letter.originalJobId ?? job.id}`,
      });
      await job.remove();
      return reply.status(202).send({ requeuedAs: requeued.id! });
    },
  );

  app.delete(
    '/admin/dead-letters/:id',
    {
      schema: {
        tags: ['admin'],
        summary: 'Discard a dead job',
        security: bearerAuth,
        params: DeadLetterParams,
        response: { 204: z.null(), ...errors },
      },
    },
    async (req, reply) => {
      const job = await getQueue(DEAD_LETTER_QUEUE).getJob(req.params.id);
      if (!job) throw notFound('Dead letter');
      await job.remove();
      return reply.status(204).send(null);
    },
  );
};
