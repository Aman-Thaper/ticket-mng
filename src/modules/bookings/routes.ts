import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { BOOKING_STATUSES } from '../../db/types.js';
import { withIdempotency } from '../../lib/idempotency.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';
import { enforce } from '../../lib/rate-limit.js';
import { assertEmailVerified } from '../auth/verification.js';
import { ErrorResponse, errors, IdParams, Limit } from '../../lib/schemas.js';
import { bearerAuth, currentUser, requireAuth } from '../auth/guard.js';
import { assertBookingOwner, BookingDto, getBookingFor, listBookingsFor } from './queries.js';
import { cancelPendingBooking, holdSeats, type BookingOptions } from './service.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Hold strategy, claim gate and hold TTL. Decorated in buildApp so scripts can override them. */
    bookingOptions: BookingOptions;
  }
}

/** Per-user throttle on placing holds: bursts of 10, then one every two seconds. */
const HOLD_LIMIT = { name: 'holds:user', capacity: 10, refillPerSec: 0.5 };

export const bookingRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/events/:id/bookings',
    {
      onRequest: requireAuth,
      schema: {
        tags: ['bookings'],
        summary: 'Hold seats (creates a pending booking)',
        description:
          'Reserves the seats for a limited time (HOLD_TTL_SECONDS, default 10 minutes). Unpaid holds expire and the seats return to sale. ' +
          'Fails with 409 SEATS_UNAVAILABLE if any seat is taken, or is being booked by someone else at this moment. ' +
          'Send an `Idempotency-Key` header to make retries safe: a repeat returns the original response.',
        security: bearerAuth,
        params: IdParams,
        headers: z.object({ 'idempotency-key': z.string().optional() }),
        body: z.object({
          seatIds: z
            .array(z.int().positive())
            .min(1)
            .max(50)
            .refine((ids) => new Set(ids).size === ids.length, 'Seat ids must be unique'),
        }),
        response: { 201: BookingDto, ...errors, 429: ErrorResponse },
      },
    },
    async (req, reply) => {
      const user = currentUser(req);
      await enforce(req, reply, [[HOLD_LIMIT, user.id]]);
      // Tickets are emailed, so the address must be confirmed before anything is booked.
      await assertEmailVerified(user.id);

      return withIdempotency(req, reply, user.id, async () => {
        const { bookingId } = await holdSeats(
          { userId: user.id, eventId: req.params.id, seatIds: req.body.seatIds },
          app.bookingOptions,
        );
        reply.header('location', `/api/v1/bookings/${bookingId}`);
        return { statusCode: 201, body: await getBookingFor(user, bookingId) };
      });
    },
  );

  app.get(
    '/bookings',
    {
      onRequest: requireAuth,
      schema: {
        tags: ['bookings'],
        summary: 'Your bookings, newest first',
        security: bearerAuth,
        querystring: z.object({
          status: z.enum(BOOKING_STATUSES).optional(),
          limit: Limit,
          cursor: z.string().optional(),
        }),
        response: {
          200: z.object({
            data: z.array(BookingDto),
            page: z.object({ limit: z.int(), nextCursor: z.string().nullable() }),
          }),
          ...errors,
        },
      },
    },
    async (req) => {
      const { status, limit, cursor } = req.query;
      const { data, last } = await listBookingsFor(currentUser(req).id, {
        status,
        limit,
        cursor: cursor ? decodeCursor(cursor) : undefined,
      });
      return {
        data,
        page: { limit, nextCursor: last ? encodeCursor({ at: last.createdAt, id: last.id }) : null },
      };
    },
  );

  app.get(
    '/bookings/:id',
    {
      onRequest: requireAuth,
      schema: {
        tags: ['bookings'],
        summary: 'Get a booking (buyer, event organizer or admin)',
        security: bearerAuth,
        params: IdParams,
        response: { 200: BookingDto, ...errors },
      },
    },
    async (req) => getBookingFor(currentUser(req), req.params.id),
  );

  app.post(
    '/bookings/:id/cancel',
    {
      onRequest: requireAuth,
      schema: {
        tags: ['bookings'],
        summary: 'Cancel a pending booking and release its seats',
        security: bearerAuth,
        params: IdParams,
        response: { 200: BookingDto, ...errors },
      },
    },
    async (req) => {
      const user = currentUser(req);
      await assertBookingOwner(user, req.params.id);
      await cancelPendingBooking(req.params.id);
      return getBookingFor(user, req.params.id);
    },
  );
};
