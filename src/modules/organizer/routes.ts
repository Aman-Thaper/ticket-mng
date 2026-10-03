import { Readable } from 'node:stream';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { db } from '../../db/index.js';
import { EVENT_STATUSES } from '../../db/types.js';
import { CSV_BOM, csvRow } from '../../lib/csv.js';
import { notFound } from '../../lib/errors.js';
import { errors, IdParams, Timestamp } from '../../lib/schemas.js';
import { bearerAuth, currentUser, requireRole } from '../auth/guard.js';
import { assertCanManage } from '../events/access.js';
import { calendarFilename } from '../tickets/calendar.js';
import {
  attendeesQuery,
  bookingCounts,
  checkInStats,
  decodeAttendeeCursor,
  encodeAttendeeCursor,
  moneyStats,
  SALES_BUCKETS,
  salesOverTime,
  seatStats,
} from './queries.js';

const Money = z.object({
  collectedCents: z.int().describe('Charged to buyers (including payments refunded later)'),
  refundedCents: z.int(),
  netCents: z.int().describe('Kept: collected minus refunded'),
});

const OrganizerEvent = z
  .object({
    id: z.uuid(),
    title: z.string(),
    category: z.string(),
    status: z.enum(EVENT_STATUSES),
    startsAt: Timestamp,
    endsAt: Timestamp,
    salesStartAt: Timestamp.nullable(),
    currency: z.string(),
    venue: z.object({ id: z.uuid(), name: z.string(), city: z.string(), timezone: z.string() }),
    seats: z.object({ total: z.int(), sold: z.int() }),
    revenueCents: z.int().describe('Net: kept after refunds'),
    checkedIn: z.int(),
  })
  .meta({ id: 'OrganizerEvent' });

const EventStats = z
  .object({
    eventId: z.uuid(),
    currency: z.string(),
    seats: z.object({ total: z.int(), sold: z.int(), held: z.int(), available: z.int() }),
    revenue: Money,
    bookings: z.object({
      pending: z.int(),
      confirmed: z.int(),
      expired: z.int(),
      cancelled: z.int(),
      refunded: z.int(),
    }),
    checkedIn: z.int(),
    sales: z.object({
      bucket: z.enum(SALES_BUCKETS),
      points: z.array(z.object({ at: Timestamp, tickets: z.int(), revenueCents: z.int() })),
    }),
  })
  .meta({ id: 'EventStats' });

const Attendee = z
  .object({
    ticketId: z.uuid(),
    name: z.string(),
    email: z.string(),
    seat: z.object({ section: z.string(), row: z.string(), number: z.int() }),
    bookingId: z.uuid(),
    purchasedAt: Timestamp.nullable(),
    checkedInAt: Timestamp.nullable(),
  })
  .meta({ id: 'Attendee' });

const AttendeesQuery = z.object({
  q: z.string().trim().min(1).max(100).optional().describe('Search by name or email'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

/** The event, if it exists and the user may manage it (404 for others' drafts, 403 otherwise). */
async function managedEvent(eventId: string, user: Parameters<typeof assertCanManage>[1]) {
  const event = await db
    .selectFrom('events as e')
    .innerJoin('venues as v', 'v.id', 'e.venueId')
    .select(['e.id', 'e.title', 'e.status', 'e.organizerId', 'e.currency', 'v.timezone'])
    .where('e.id', '=', eventId)
    .executeTakeFirst();
  if (!event) throw notFound('Event');
  assertCanManage(event, user);
  return event;
}

/** "2026-10-09 19:42", in the venue's time zone: what a spreadsheet reads as a date and time. */
function localStamp(date: Date | null, timeZone: string) {
  if (!date) return '';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export const organizerRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/organizer/events',
    {
      onRequest: requireRole('organizer', 'admin'),
      schema: {
        tags: ['organizer'],
        summary: 'Your events, every status, with seats sold, revenue and check-ins',
        description: 'Admins see every event. At most 200, soonest first.',
        security: bearerAuth,
        response: { 200: z.object({ data: z.array(OrganizerEvent) }), ...errors },
      },
    },
    async (req) => {
      const user = currentUser(req);
      let query = db
        .selectFrom('events as e')
        .innerJoin('venues as v', 'v.id', 'e.venueId')
        .select([
          'e.id',
          'e.title',
          'e.category',
          'e.status',
          'e.startsAt',
          'e.endsAt',
          'e.salesStartAt',
          'e.currency',
          'v.id as venueId',
          'v.name as venueName',
          'v.city as venueCity',
          'v.timezone as venueTimezone',
        ]);
      if (user.role !== 'admin') query = query.where('e.organizerId', '=', user.id);
      const events = await query.orderBy('e.startsAt').limit(200).execute();
      const ids = events.map((e) => e.id);
      const [seats, money, checkIns] = await Promise.all([
        seatStats(ids),
        moneyStats(ids),
        checkInStats(ids),
      ]);
      return {
        data: events.map((e) => ({
          id: e.id,
          title: e.title,
          category: e.category,
          status: e.status,
          startsAt: e.startsAt.toISOString(),
          endsAt: e.endsAt.toISOString(),
          salesStartAt: e.salesStartAt?.toISOString() ?? null,
          currency: e.currency.trim(),
          venue: { id: e.venueId, name: e.venueName, city: e.venueCity, timezone: e.venueTimezone },
          seats: { total: seats.get(e.id)?.total ?? 0, sold: seats.get(e.id)?.sold ?? 0 },
          revenueCents: money.get(e.id)?.netCents ?? 0,
          checkedIn: checkIns.get(e.id) ?? 0,
        })),
      };
    },
  );

  app.get(
    '/events/:id/stats',
    {
      onRequest: requireRole('organizer', 'admin'),
      schema: {
        tags: ['organizer'],
        summary: "An event's dashboard numbers: seats, revenue, bookings, check-ins, sales over time",
        description:
          'Sales are tickets in confirmed bookings, bucketed by 5 minutes (last 24 hours), hour (last 14 days) or day, ' +
          "in the venue's time zone. Event organizer or admin.",
        security: bearerAuth,
        params: IdParams,
        querystring: z.object({ bucket: z.enum(SALES_BUCKETS).default('1h') }),
        response: { 200: EventStats, ...errors },
      },
    },
    async (req) => {
      const event = await managedEvent(req.params.id, currentUser(req));
      const [seats, money, checkIns, bookings, points] = await Promise.all([
        seatStats([event.id]),
        moneyStats([event.id]),
        checkInStats([event.id]),
        bookingCounts(event.id),
        salesOverTime(event.id, event.timezone, req.query.bucket),
      ]);
      const s = seats.get(event.id) ?? { total: 0, sold: 0, available: 0 };
      return {
        eventId: event.id,
        currency: event.currency.trim(),
        seats: { ...s, held: s.total - s.sold - s.available },
        revenue: money.get(event.id)!,
        bookings,
        checkedIn: checkIns.get(event.id) ?? 0,
        sales: { bucket: req.query.bucket, points },
      };
    },
  );

  app.get(
    '/events/:id/attendees',
    {
      onRequest: requireRole('organizer', 'admin'),
      schema: {
        tags: ['organizer'],
        summary: "An event's attendees: one row per valid ticket, by name (event organizer or admin)",
        security: bearerAuth,
        params: IdParams,
        querystring: AttendeesQuery,
        response: {
          200: z.object({
            data: z.array(Attendee),
            page: z.object({ limit: z.int(), nextCursor: z.string().nullable() }),
          }),
          ...errors,
        },
      },
    },
    async (req) => {
      const event = await managedEvent(req.params.id, currentUser(req));
      const { q, limit, cursor } = req.query;
      const rows = await attendeesQuery(event.id, {
        q,
        after: cursor ? decodeAttendeeCursor(cursor) : undefined,
      })
        .limit(limit + 1)
        .execute();
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        data: page.map((r) => ({
          ticketId: r.ticketId,
          name: r.name,
          email: r.email,
          seat: { section: r.section, row: r.rowLabel, number: r.seatNumber },
          bookingId: r.bookingId,
          purchasedAt: r.confirmedAt?.toISOString() ?? null,
          checkedInAt: r.checkedInAt?.toISOString() ?? null,
        })),
        page: {
          limit,
          nextCursor: rows.length > limit && last ? encodeAttendeeCursor(last.name, last.ticketId) : null,
        },
      };
    },
  );

  app.get(
    '/events/:id/attendees.csv',
    {
      onRequest: requireRole('organizer', 'admin'),
      schema: {
        tags: ['organizer'],
        summary: 'All attendees as a spreadsheet (CSV), streamed',
        description:
          'Times are in the venue time zone. Cells that a spreadsheet would run as formulas (starting with = + - @) ' +
          'are prefixed with an apostrophe, so a name typed by a buyer can never become a formula.',
        security: bearerAuth,
        params: IdParams,
        querystring: z.object({ q: AttendeesQuery.shape.q }),
        response: {
          200: { description: 'The CSV file', content: { 'text/csv': { schema: z.string() } } },
          ...errors,
        },
      },
    },
    async (req, reply) => {
      const event = await managedEvent(req.params.id, currentUser(req));
      const { q } = req.query;

      // A page of 1,000 at a time (keyset), so a 50,000-ticket show never sits in memory.
      async function* lines() {
        yield CSV_BOM +
          csvRow([
            'Name',
            'Email',
            'Section',
            'Row',
            'Seat',
            'Booking',
            'Purchased (venue time)',
            'Checked in (venue time)',
          ]);
        let after: { n: string; id: string } | undefined;
        for (;;) {
          const rows = await attendeesQuery(event.id, { q, after }).limit(1_000).execute();
          if (!rows.length) return;
          yield rows
            .map((r) =>
              csvRow([
                r.name,
                r.email,
                r.section,
                r.rowLabel,
                r.seatNumber,
                r.bookingId,
                localStamp(r.confirmedAt, event.timezone),
                localStamp(r.checkedInAt, event.timezone),
              ]),
            )
            .join('');
          const last = rows.at(-1)!;
          after = { n: last.name, id: last.ticketId };
        }
      }

      const filename = calendarFilename(event.title).replace(/\.ics$/, '-attendees.csv');
      return reply
        .type('text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${filename}"`)
        .header('cache-control', 'private, no-store')
        .send(Readable.from(lines()) as never); // Fastify streams any Readable; the schema documents its text
    },
  );
};
