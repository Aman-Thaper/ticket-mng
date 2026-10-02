import { z } from 'zod';
import { sql } from 'kysely';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { config } from '../../config.js';
import { db } from '../../db/index.js';
import { TICKET_STATUSES } from '../../db/types.js';
import { MicroCache } from '../../lib/cache.js';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import { sendCachedJson } from '../../lib/http-cache.js';
import { errors, IdParams, Timestamp, TimestampInput } from '../../lib/schemas.js';
import { bearerAuth, canManage, currentUser, requireAuth, requireRole } from '../auth/guard.js';
import { assertBookingOwner } from '../bookings/queries.js';
import { assertCanManage } from '../events/access.js';
import { bookingCalendar, calendarFilename, loadBookingForCalendar } from './calendar.js';
import { qrDataUrl, ticketsForBooking } from './service.js';
import { publicKeyJwk, publicKeyPem, verifyTicket } from './signing.js';

const Seat = z.object({ section: z.string(), row: z.string(), number: z.int() });

/** An offline scan synced later keeps its real time, within these bounds. */
const MAX_OFFLINE_AGE_MS = 24 * 3_600_000;

const AttendanceDto = z
  .object({
    eventId: z.uuid(),
    sold: z.int().describe('Valid tickets (refunded ones excluded)'),
    checkedIn: z.int().describe('Valid tickets scanned at the door'),
    recent: z
      .array(z.object({ ticketId: z.uuid(), holder: z.string(), seat: Seat, checkedInAt: Timestamp }))
      .describe('The latest 10 check-ins, newest first'),
  })
  .meta({ id: 'Attendance' });

/** Every scanner at the door polls this: in-process, 1 s, like the other live numbers. */
const attendanceCache = new MicroCache('attendance', config.MICRO_CACHE_TTL_MS, 100);

async function loadAttendance(eventId: string): Promise<string> {
  const [counts, recent] = await Promise.all([
    db
      .selectFrom('tickets')
      .where('eventId', '=', eventId)
      .select([
        sql<number>`count(*) FILTER (WHERE status = 'valid')`.as('sold'),
        sql<number>`count(*) FILTER (WHERE status = 'valid' AND checked_in_at IS NOT NULL)`.as('checkedIn'),
      ])
      .executeTakeFirstOrThrow(),
    // Served by tickets_event_checkin_idx: the newest scans are the first rows of the range.
    db
      .selectFrom('tickets as t')
      .innerJoin('bookings as b', 'b.id', 't.bookingId')
      .innerJoin('users as u', 'u.id', 'b.userId')
      .innerJoin('eventSeats as es', 'es.id', 't.eventSeatId')
      .innerJoin('venueSeats as vs', 'vs.id', 'es.venueSeatId')
      .innerJoin('venueSections as sec', 'sec.id', 'vs.sectionId')
      .select([
        't.id',
        't.checkedInAt',
        'u.name as holder',
        'sec.name as section',
        'vs.rowLabel',
        'vs.seatNumber',
      ])
      .where('t.eventId', '=', eventId)
      .where('t.checkedInAt', 'is not', null)
      .orderBy('t.checkedInAt', 'desc')
      .limit(10)
      .execute(),
  ]);
  const attendance: z.infer<typeof AttendanceDto> = {
    eventId,
    sold: counts.sold,
    checkedIn: counts.checkedIn,
    recent: recent.map((r) => ({
      ticketId: r.id,
      holder: r.holder,
      seat: { section: r.section, row: r.rowLabel, number: r.seatNumber },
      checkedInAt: r.checkedInAt!.toISOString(),
    })),
  };
  return JSON.stringify(attendance);
}

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
    '/bookings/:id/calendar.ics',
    {
      onRequest: requireAuth,
      schema: {
        tags: ['tickets'],
        summary: 'A confirmed booking as a calendar entry (.ics)',
        description:
          'An iCalendar file (text/calendar) for Apple Calendar, Outlook or Google Calendar, with a reminder 2 hours ' +
          'before. Its UID is fixed per booking, so adding it twice updates one entry. The ticket email attaches the same file.',
        security: bearerAuth,
        params: IdParams,
        response: {
          200: {
            description: 'The calendar file',
            content: { 'text/calendar': { schema: z.string() } },
          },
          ...errors,
        },
      },
    },
    async (req, reply) => {
      await assertBookingOwner(currentUser(req), req.params.id);
      const booking = await loadBookingForCalendar(req.params.id);
      if (booking?.status !== 'confirmed') {
        throw conflict('BOOKING_NOT_CONFIRMED', 'Only a confirmed booking can be added to a calendar');
      }
      return reply
        .type('text/calendar; charset=utf-8')
        .header('content-disposition', `attachment; filename="${calendarFilename(booking.event.title)}"`)
        .header('cache-control', 'private, no-store')
        .send(bookingCalendar(booking));
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

  app.get(
    '/events/:id/attendance',
    {
      onRequest: requireRole('organizer', 'admin'),
      schema: {
        tags: ['tickets'],
        summary: 'Live attendance: tickets checked in and the latest scans (event organizer or admin)',
        description:
          'Door scanners and the organizer dashboard poll this every few seconds. Answers from a 1 s cache, ' +
          'with an ETag, so an unchanged count costs a 304.',
        security: bearerAuth,
        params: IdParams,
        response: { 200: AttendanceDto, ...errors },
      },
    },
    async (req, reply) => {
      const event = await db
        .selectFrom('events')
        .select(['id', 'status', 'organizerId'])
        .where('id', '=', req.params.id)
        .executeTakeFirst();
      if (!event) throw notFound('Event');
      assertCanManage(event, currentUser(req));
      const cached = await attendanceCache.get(event.id, () => loadAttendance(event.id));
      return sendCachedJson(req, reply, cached, 'private, no-cache');
    },
  );

  app.post(
    '/check-in',
    {
      onRequest: requireRole('organizer', 'admin'),
      schema: {
        tags: ['tickets'],
        summary: 'Scan a ticket at the door (event organizer or admin)',
        description:
          'Verifies the QR signature, then marks the ticket used with a single conditional UPDATE, so two scanners reading the same code at the same moment can admit it only once. ' +
          'A scanner that admitted someone while offline sends the check-in later, with `scannedAt`.',
        security: bearerAuth,
        body: z.object({
          token: z.string().min(1).max(400),
          scannedAt: TimestampInput.optional().describe(
            'For a scan made offline and synced later: when it happened (within the last 24 hours)',
          ),
        }),
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
      const now = Date.now();
      const scannedAt = req.body.scannedAt ? Date.parse(req.body.scannedAt) : now;
      if (scannedAt < now - MAX_OFFLINE_AGE_MS) {
        throw new AppError(400, 'VALIDATION_ERROR', 'scannedAt must be within the last 24 hours');
      }

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
        // A scanner clock running a little fast can't put a check-in in the future.
        .set({ checkedInAt: scannedAt < now ? new Date(scannedAt) : sql`now()`, checkedInBy: user.id })
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
