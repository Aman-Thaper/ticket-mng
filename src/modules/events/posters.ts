import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { config } from '../../config.js';
import { db } from '../../db/index.js';
import { enqueue } from '../../jobs/outbox.js';
import { notFound, unprocessable } from '../../lib/errors.js';
import { errors, IdParams, Timestamp } from '../../lib/schemas.js';
import { headObject, presignPosterUpload } from '../../lib/storage.js';
import { bearerAuth, currentUser, requireRole } from '../auth/guard.js';
import { assertCanManage } from './access.js';
import { PosterDto, posterDto } from './schemas.js';

async function loadManagedEvent(eventId: string, req: Parameters<typeof currentUser>[0]) {
  const event = await db
    .selectFrom('events')
    .select(['id', 'status', 'organizerId'])
    .where('id', '=', eventId)
    .executeTakeFirst();
  if (!event) throw notFound('Event');
  assertCanManage(event, currentUser(req));
  return event;
}

/**
 * Poster upload in three steps, and the file never passes through the API:
 *   1. POST /events/:id/poster/upload-url  → a presigned POST, valid for one upload (≤ 10 MB, image/*)
 *   2. the browser POSTs the file straight to object storage
 *   3. PUT  /events/:id/poster {key}        → a worker resizes it; poster.status goes processing → ready
 */
export const posterRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/events/:id/poster/upload-url',
    {
      onRequest: requireRole('organizer', 'admin'),
      schema: {
        tags: ['events'],
        summary: 'Get a presigned upload for the event poster (step 1 of 3)',
        description:
          'POST the file to `url` as multipart/form-data: every entry of `fields` first, then the file as `file`. Then call PUT /events/:id/poster with `key`.',
        security: bearerAuth,
        params: IdParams,
        response: {
          200: z.object({
            url: z.url(),
            fields: z.record(z.string(), z.string()),
            key: z.string(),
            maxBytes: z.int(),
            expiresAt: Timestamp,
          }),
          ...errors,
        },
      },
    },
    async (req) => {
      const event = await loadManagedEvent(req.params.id, req);
      return presignPosterUpload(event.id);
    },
  );

  app.put(
    '/events/:id/poster',
    {
      onRequest: requireRole('organizer', 'admin'),
      schema: {
        tags: ['events'],
        summary: 'Use an uploaded file as the event poster (step 3 of 3)',
        description:
          'Queues resizing and answers 202. Poll the event: poster.status becomes ready (or failed).',
        security: bearerAuth,
        params: IdParams,
        body: z.object({ key: z.string().min(1).max(300) }),
        response: { 202: z.object({ poster: PosterDto }), ...errors },
      },
    },
    async (req, reply) => {
      const event = await loadManagedEvent(req.params.id, req);
      const { key } = req.body;

      // The key must be one we issued for this event, not another event's upload or some
      // arbitrary object in the bucket.
      if (!key.startsWith(`uploads/posters/${event.id}/`)) {
        throw unprocessable('INVALID_UPLOAD_KEY', 'This upload does not belong to this event');
      }
      const object = await headObject(key);
      if (!object) throw unprocessable('UPLOAD_NOT_FOUND', 'Nothing has been uploaded with this key yet');
      if (object.size > config.POSTER_MAX_BYTES)
        throw unprocessable('UPLOAD_TOO_LARGE', 'The uploaded file is too large');

      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable('events')
          .set({ posterStatus: 'processing', posterKey: key, posterError: null })
          .where('id', '=', event.id)
          .execute();
        await enqueue(
          trx,
          'media',
          'process-poster',
          { eventId: event.id, key },
          { jobId: `poster_${key.replaceAll('/', '_')}` },
        );
      });

      return reply.status(202).send({ poster: posterDto('processing', null, null)! });
    },
  );
};
