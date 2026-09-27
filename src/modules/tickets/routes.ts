import { z } from 'zod';
import { sql } from 'kysely';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { db } from '../../db/index.js';
import { TICKET_STATUSES } from '../../db/types.js';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import { errors, IdParams, Timestamp } from '../../lib/schemas.js';
import { bearerAuth, canManage, currentUser, requireAuth, requireRole } from '../auth/guard.js';
import { assertBookingOwner } from '../bookings/queries.js';
import { qrDataUrl, ticketsForBooking } from './service.js';
import { publicKeyJwk, publicKeyPem, verifyTicket } from './signing.js';

const Seat = z.object({ section: z.string(), row: z.string(), number: z.int() });

export const ticketRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/bookings/:id/tickets',
    {
      onRequest: requireAuth,
      schema: {
        tags: ['tickets'],
        summary: "A confirmed booking's tickets, with QR codes",
        security: bearerAuth,
        params: IdParams,
        response: {
          200: z.array(
            z.object({
              id: z.uuid(),
              status: z.enum(TICKET_STATUSES),
              checkedInAt: Timestamp.nullable(),
              seat: Seat,
              token: z.string().describe('Signed ticket token (what the QR code encodes)'),
              qr: z.string().describe('The QR code as a PNG data URL'),
            }),
          ),
          ...errors,
        },
      },
    },
    async (req) => {
      await assertBookingOwner(currentUser(req), req.params.id);
      const tickets = await ticketsForBooking(req.params.id);
      return Promise.all(
        tickets.map(async (t) => ({
          id: t.id,
          status: t.status,
          checkedInAt: t.checkedInAt?.toISOString() ?? null,
          seat: { section: t.section, row: t.row, number: t.number },
          token: t.token,
          qr: await qrDataUrl(t.token),
        })),
      );
    },
  );

  app.get(
    '/tickets/public-key',
    {
      schema: {
        tags: ['tickets'],
        summary: 'Public key for verifying ticket QR codes offline (Ed25519)',
        response: {
          200: z.object({
            algorithm: z.literal('Ed25519'),
            pem: z.string(),
            jwk: z.record(z.string(), z.unknown()),
          }),
        },
      },
    },
    async () => ({ algorithm: 'Ed25519' as const, pem: publicKeyPem, jwk: { ...publicKeyJwk } }),
  );

  app.post(
    '/check-in',
    {
      onRequest: requireRole('organizer', 'admin'),
      schema: {
        tags: ['tickets'],
        summary: 'Scan a ticket at the door (event organizer or admin)',
        description:
          'Verifies the QR signature, then marks the ticket used with a single conditional UPDATE, so two scanners reading the same code at the same moment can admit it only once.',
        security: bearerAuth,
        body: z.object({ token: z.string().min(1).max(400) }),
        response: {
          200: z.object({
            ticketId: z.uuid(),
            checkedInAt: Timestamp,
            event: z.object({ id: z.uuid(), title: z.string() }),
            seat: Seat,
            holder: z.string(),
          }),
          ...errors,
        },
      },
    },
    async (req) => {
      const user = currentUser(req);
      const claims = verifyTicket(req.body.token);
      if (!claims) throw new AppError(400, 'INVALID_TICKET', 'This is not a genuine ticket');

      const ticket = await db
        .selectFrom('tickets as t')
        .innerJoin('events as e', 'e.id', 't.eventId')
        .innerJoin('bookings as b', 'b.id', 't.bookingId')
        .innerJoin('users as u', 'u.id', 'b.userId')
        .innerJoin('eventSeats as es', 'es.id', 't.eventSeatId')
        .innerJoin('venueSeats as vs', 'vs.id', 'es.venueSeatId')
        .innerJoin('venueSections as sec', 'sec.id', 'vs.sectionId')
        .select([
          't.id',
          't.status',
          't.checkedInAt',
          'e.id as eventId',
          'e.title',
          'e.organizerId',
          'u.name as holder',
          'sec.name as section',
          'vs.rowLabel',
          'vs.seatNumber',
        ])
        .where('t.id', '=', claims.ticketId)
        .where('t.eventId', '=', claims.eventId)
        .executeTakeFirst();
      if (!ticket) throw notFound('Ticket');
      if (!canManage(user, ticket.organizerId))
        throw new AppError(403, 'FORBIDDEN', 'You can only check in tickets for your own events');

      // The atomic step: only one scan can move checked_in_at from NULL to a timestamp.
      const admitted = await db
        .updateTable('tickets')
        .set({ checkedInAt: sql`now()`, checkedInBy: user.id })
        .where('id', '=', ticket.id)
        .where('status', '=', 'valid')
        .where('checkedInAt', 'is', null)
        .returning('checkedInAt')
        .executeTakeFirst();

      if (!admitted) {
        const current = await db
          .selectFrom('tickets')
          .select(['status', 'checkedInAt'])
          .where('id', '=', ticket.id)
          .executeTakeFirstOrThrow();
        if (current.status === 'void')
          throw conflict('TICKET_VOID', 'This ticket was refunded and is no longer valid');
        throw conflict('ALREADY_CHECKED_IN', 'This ticket has already been used', {
          checkedInAt: current.checkedInAt?.toISOString(),
        });
      }

      return {
        ticketId: ticket.id,
        checkedInAt: admitted.checkedInAt!.toISOString(),
        event: { id: ticket.eventId, title: ticket.title },
        seat: { section: ticket.section, row: ticket.rowLabel, number: ticket.seatNumber },
        holder: ticket.holder,
      };
    },
  );
};
