import { z } from 'zod';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { db } from '../../db/index.js';
import { withTransaction } from '../../db/transaction.js';
import type { DB, SeatStatus } from '../../db/types.js';
import { AppError, conflict, forbidden, notFound, unauthorized, unprocessable } from '../../lib/errors.js';
import { acquirableSql, cancelPendingBookingsForEvent } from '../bookings/service.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';
import { errors, IdParams } from '../../lib/schemas.js';
import { bearerAuth, currentUser, optionalAuth, requireRole, type AuthUser } from '../auth/guard.js';
import { assertCanManage, isVisible } from './access.js';
import { posterDto, type EventDto } from './schemas.js';
import {
  CreateEventBody,
  EventDetailDto,
  EventListResponse,
  ListEventsQuery,
  SeatMapResponse,
  STATUS_TRANSITIONS,
  UpdateEventBody,
} from './schemas.js';

/** Event columns + a small venue summary. Shared by every endpoint that returns events. */
function selectEvents(conn: Kysely<DB>) {
  return conn
    .selectFrom('events as e')
    .innerJoin('venues as v', 'v.id', 'e.venueId')
    .select([
      'e.id',
      'e.organizerId',
      'e.title',
      'e.description',
      'e.category',
      'e.status',
      'e.startsAt',
      'e.endsAt',
      'e.salesStartAt',
      'e.maxTicketsPerUser',
      'e.currency',
      'e.posterStatus',
      'e.posterVariants',
      'e.posterError',
      'e.createdAt',
      'e.updatedAt',
      'v.id as venueId',
      'v.name as venueName',
      'v.city as venueCity',
    ]);
}

type EventRow = Awaited<ReturnType<ReturnType<typeof selectEvents>['executeTakeFirstOrThrow']>>;

const toEventDto = (r: EventRow): z.infer<typeof EventDto> => ({
  id: r.id,
  organizerId: r.organizerId,
  venue: { id: r.venueId, name: r.venueName, city: r.venueCity },
  title: r.title,
  description: r.description,
  category: r.category,
  status: r.status,
  startsAt: r.startsAt.toISOString(),
  endsAt: r.endsAt.toISOString(),
  salesStartAt: r.salesStartAt?.toISOString() ?? null,
  maxTicketsPerUser: r.maxTicketsPerUser,
  currency: r.currency.trim(),
  poster: posterDto(r.posterStatus, r.posterVariants, r.posterError),
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

async function getEventDetail(id: string, viewer: AuthUser | null): Promise<z.infer<typeof EventDetailDto>> {
  const [event, stats] = await Promise.all([
    selectEvents(db).where('e.id', '=', id).executeTakeFirst(),
    db
      .selectFrom('eventSeats as es')
      .leftJoin('bookings as b', 'b.id', 'es.bookingId')
      .where('es.eventId', '=', id)
      .select((eb) => [
        eb.fn.countAll<number>().as('total'),
        // Seats of lapsed holds count as available, whether or not the expiry job has run.
        sql<number>`count(*) FILTER (WHERE ${acquirableSql})`.as('available'),
        eb.fn.min('es.priceCents').as('minCents'),
        eb.fn.max('es.priceCents').as('maxCents'),
      ])
      .executeTakeFirstOrThrow(),
  ]);
  if (!event || !isVisible(event, viewer)) throw notFound('Event');

  return {
    ...toEventDto(event),
    seats: { total: stats.total, available: stats.available },
    priceRange: stats.minCents === null ? null : { minCents: stats.minCents, maxCents: stats.maxCents },
  };
}

/** Postgres raises 23P01 when the events_no_venue_overlap exclusion constraint fires. */
function isVenueOverlap(err: unknown) {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === '23P01' &&
    (err as { constraint?: string }).constraint === 'events_no_venue_overlap'
  );
}

/** Take the venue's schedule lock (see POST /events). */
async function lockVenueSchedule(trx: Transaction<DB>, venueId: string) {
  const venue = await trx
    .selectFrom('venues')
    .select('id')
    .where('id', '=', venueId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (!venue) throw unprocessable('VENUE_NOT_FOUND', 'Venue does not exist');
}

const venueOverlap = () =>
  conflict('VENUE_TIME_CONFLICT', 'The venue already has an event overlapping this time slot');

export const eventRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/events',
    {
      onRequest: requireRole('organizer', 'admin'),
      schema: {
        tags: ['events'],
        summary: 'Create an event (as a draft) and its seat inventory',
        security: bearerAuth,
        body: CreateEventBody,
        response: { 201: EventDetailDto, ...errors },
      },
    },
    async (req, reply) => {
      const user = currentUser(req);
      const { pricing, venueId, ...fields } = req.body;

      const sections = await db
        .selectFrom('venueSections')
        .select('name')
        .where('venueId', '=', venueId)
        .execute();
      if (sections.length === 0) throw unprocessable('VENUE_NOT_FOUND', 'Venue does not exist');

      const sectionNames = new Set(sections.map((s) => s.name));
      const pricedNames = new Set(pricing.map((p) => p.section));
      const missing = [...sectionNames].filter((n) => !pricedNames.has(n));
      const unknown = [...pricedNames].filter((n) => !sectionNames.has(n));
      if (missing.length || unknown.length || pricedNames.size !== pricing.length) {
        throw unprocessable('INVALID_PRICING', 'Pricing must list each venue section exactly once', {
          missing,
          unknown,
        });
      }

      let eventId: string;
      try {
        eventId = await withTransaction(async (trx) => {
          // Serialize schedule changes per venue. Without this, two concurrent inserts for
          // overlapping slots can each find the other's uncommitted row in the exclusion
          // constraint check and wait on each other: a deadlock that Postgres only breaks
          // after deadlock_timeout (1 s), once per victim. With the venue row locked, they
          // queue up instead, and each later one fails fast with a clean 23P01 (409).
          // NO KEY UPDATE doesn't block the foreign-key checks of unrelated inserts.
          await lockVenueSchedule(trx, venueId);

          const { id } = await trx
            .insertInto('events')
            .values({
              ...fields,
              organizerId: user.id,
              venueId,
              startsAt: new Date(fields.startsAt),
              endsAt: new Date(fields.endsAt),
              salesStartAt: fields.salesStartAt ? new Date(fields.salesStartAt) : null,
            })
            .returning('id')
            .executeTakeFirstOrThrow();

          // Copy the venue's physical seats into this event's inventory, priced by section.
          // One set-based statement, whether the venue has 50 seats or 50,000.
          await sql`
            INSERT INTO event_seats (event_id, venue_seat_id, price_cents)
            SELECT ${id}::uuid, vs.id, p.price_cents
            FROM venue_seats vs
            JOIN venue_sections sec ON sec.id = vs.section_id
            JOIN unnest(${pricing.map((p) => p.section)}::text[], ${pricing.map((p) => p.priceCents)}::int[])
              AS p(section_name, price_cents) ON p.section_name = sec.name
            WHERE sec.venue_id = ${venueId}::uuid
          `.execute(trx);

          return id;
        });
      } catch (err) {
        if (isVenueOverlap(err)) throw venueOverlap();
        throw err;
      }

      return reply
        .status(201)
        .header('location', `/api/v1/events/${eventId}`)
        .send(await getEventDetail(eventId, user));
    },
  );

  app.get(
    '/events',
    {
      onRequest: optionalAuth,
      schema: {
        tags: ['events'],
        summary: 'Search and list events (cursor pagination, ordered by start time)',
        querystring: ListEventsQuery,
        response: { 200: EventListResponse, ...errors },
      },
    },
    async (req) => {
      const { q, city, category, venueId, status, from, to, limit, cursor } = req.query;
      let { organizerId } = req.query;

      if (status === 'draft') {
        const user = req.user;
        if (!user) throw unauthorized();
        if (user.role === 'attendee') throw forbidden('Only organizers can list drafts');
        if (user.role === 'organizer') {
          if (organizerId && organizerId !== user.id) throw forbidden('You can only list your own drafts');
          organizerId = user.id;
        }
      }

      let query = selectEvents(db).where('e.status', '=', status);
      if (q) query = query.where(sql<boolean>`e.search @@ websearch_to_tsquery('english', ${q})`);
      if (city) query = query.where(sql`lower(v.city)`, '=', city.toLowerCase());
      if (category) query = query.where('e.category', '=', category);
      if (venueId) query = query.where('e.venueId', '=', venueId);
      if (organizerId) query = query.where('e.organizerId', '=', organizerId);
      // Upcoming events by default. Pass an earlier `from` to include past ones.
      query = query.where('e.startsAt', '>=', from ? new Date(from) : new Date());
      if (to) query = query.where('e.startsAt', '<', new Date(to));
      if (cursor) {
        const c = decodeCursor(cursor);
        // A row-value comparison matches the (status, starts_at, id) index exactly.
        query = query.where(sql<boolean>`(e.starts_at, e.id) > (${c.at}::timestamptz, ${c.id}::uuid)`);
      }

      // Fetch one extra row. If it comes back, there's another page.
      const rows = await query
        .orderBy('e.startsAt')
        .orderBy('e.id')
        .limit(limit + 1)
        .execute();

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page.at(-1);

      return {
        data: page.map(toEventDto),
        page: {
          limit,
          nextCursor: hasMore && last ? encodeCursor({ at: last.startsAt, id: last.id }) : null,
        },
      };
    },
  );

  app.get(
    '/events/:id',
    {
      onRequest: optionalAuth,
      schema: {
        tags: ['events'],
        summary: 'Get an event with seat availability and price range',
        params: IdParams,
        response: { 200: EventDetailDto, ...errors },
      },
    },
    async (req) => getEventDetail(req.params.id, req.user),
  );

  app.patch(
    '/events/:id',
    {
      onRequest: requireRole('organizer', 'admin'),
      schema: {
        tags: ['events'],
        summary: 'Update an event or change its status (owner or admin)',
        description: `Status transitions: ${Object.entries(STATUS_TRANSITIONS)
          .map(([from, to]) => `${from} → ${to.length ? to.join(' | ') : '(final)'}`)
          .join('; ')}. Cancelled events cannot be edited.`,
        security: bearerAuth,
        params: IdParams,
        body: UpdateEventBody,
        response: { 200: EventDetailDto, ...errors },
      },
    },
    async (req) => {
      const user = currentUser(req);
      const { id } = req.params;
      const patch = req.body;

      try {
        await withTransaction(async (trx) => {
          // FOR UPDATE locks the row until commit, so two concurrent PATCHes can't both read
          // "draft" and apply conflicting transitions.
          const current = await trx
            .selectFrom('events')
            .select(['status', 'organizerId', 'venueId', 'startsAt', 'endsAt', 'salesStartAt'])
            .where('id', '=', id)
            .forUpdate()
            .executeTakeFirst();
          if (!current) throw notFound('Event');
          assertCanManage(current, user);

          if (current.status === 'cancelled') {
            throw conflict('EVENT_CANCELLED', 'Cancelled events cannot be modified');
          }
          if (
            patch.status &&
            patch.status !== current.status &&
            !STATUS_TRANSITIONS[current.status].includes(patch.status)
          ) {
            throw conflict(
              'INVALID_STATUS_TRANSITION',
              `Cannot change status from ${current.status} to ${patch.status}`,
              {
                allowed: STATUS_TRANSITIONS[current.status],
              },
            );
          }

          const startsAt = patch.startsAt ? new Date(patch.startsAt) : current.startsAt;
          const endsAt = patch.endsAt ? new Date(patch.endsAt) : current.endsAt;
          const salesStartAt =
            patch.salesStartAt === undefined
              ? current.salesStartAt
              : patch.salesStartAt
                ? new Date(patch.salesStartAt)
                : null;
          if (endsAt <= startsAt) {
            throw new AppError(400, 'VALIDATION_ERROR', 'endsAt must be after startsAt');
          }
          if (salesStartAt && salesStartAt >= startsAt) {
            throw new AppError(400, 'VALIDATION_ERROR', 'salesStartAt must be before startsAt');
          }
          // Moving an event in time is a schedule change: same per-venue lock as creation.
          if (patch.startsAt || patch.endsAt) await lockVenueSchedule(trx, current.venueId);

          await trx
            .updateTable('events')
            .set({ ...patch, startsAt, endsAt, salesStartAt })
            .where('id', '=', id)
            .execute();

          // Cancelling the event voids every seat hold on it. (Paid bookings are refunded by
          // the payments flow.)
          if (patch.status === 'cancelled') await cancelPendingBookingsForEvent(trx, id);
        });
      } catch (err) {
        if (isVenueOverlap(err)) throw venueOverlap();
        throw err;
      }

      return getEventDetail(id, user);
    },
  );

  app.delete(
    '/events/:id',
    {
      onRequest: requireRole('organizer', 'admin'),
      schema: {
        tags: ['events'],
        summary: 'Delete a draft event (owner or admin)',
        description:
          'Only drafts can be deleted. Published events must be cancelled instead, which keeps their history.',
        security: bearerAuth,
        params: IdParams,
        response: { 204: z.null().describe('Deleted'), ...errors },
      },
    },
    async (req, reply) => {
      const event = await db
        .selectFrom('events')
        .select(['status', 'organizerId'])
        .where('id', '=', req.params.id)
        .executeTakeFirst();
      if (!event) throw notFound('Event');
      assertCanManage(event, currentUser(req));

      // The status condition makes this safe even if the event is published concurrently.
      const deleted = await db
        .deleteFrom('events')
        .where('id', '=', req.params.id)
        .where('status', '=', 'draft')
        .returning('id')
        .executeTakeFirst();
      if (!deleted) {
        throw conflict(
          'EVENT_NOT_DRAFT',
          `Only draft events can be deleted (status is ${event.status}); cancel it instead`,
        );
      }
      return reply.status(204).send(null);
    },
  );

  app.get(
    '/events/:id/seats',
    {
      onRequest: optionalAuth,
      schema: {
        tags: ['events'],
        summary: 'Seat map for an event, with price and status per seat',
        params: IdParams,
        response: { 200: SeatMapResponse, ...errors },
      },
    },
    async (req) => {
      const event = await db
        .selectFrom('events')
        .select(['id', 'currency', 'status', 'organizerId'])
        .where('id', '=', req.params.id)
        .executeTakeFirst();
      if (!event || !isVisible(event, req.user)) throw notFound('Event');

      const rows = await db
        .selectFrom('eventSeats as es')
        .innerJoin('venueSeats as vs', 'vs.id', 'es.venueSeatId')
        .innerJoin('venueSections as sec', 'sec.id', 'vs.sectionId')
        .leftJoin('bookings as b', 'b.id', 'es.bookingId')
        .where('es.eventId', '=', event.id)
        .select([
          'es.id',
          'es.priceCents',
          // A seat whose hold has lapsed is shown as available straight away, even before
          // the expiry job has released it.
          sql<SeatStatus>`CASE WHEN ${acquirableSql} THEN 'available'::seat_status ELSE es.status END`.as(
            'status',
          ),
          'es.version',
          'vs.rowLabel',
          'vs.seatNumber',
          'vs.x',
          'vs.y',
          'sec.name as section',
        ])
        .orderBy('sec.sortOrder')
        .orderBy('vs.y')
        .orderBy('vs.x')
        .execute();

      const sections = new Map<string, z.infer<typeof SeatMapResponse>['sections'][number]>();
      for (const r of rows) {
        let section = sections.get(r.section);
        if (!section) sections.set(r.section, (section = { name: r.section, seats: [] }));
        section.seats.push({
          id: r.id,
          row: r.rowLabel,
          number: r.seatNumber,
          x: r.x,
          y: r.y,
          priceCents: r.priceCents,
          status: r.status,
          version: r.version,
        });
      }

      return { eventId: event.id, currency: event.currency.trim(), sections: [...sections.values()] };
    },
  );
};
