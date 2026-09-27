import { z } from 'zod';
import { sql, type Kysely } from 'kysely';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { db } from '../../db/index.js';
import type { DB } from '../../db/types.js';
import { AppError, conflict, notFound, unprocessable } from '../../lib/errors.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';
import { errors, IdParams } from '../../lib/schemas.js';
import {
  CreateEventBody,
  EventDetailDto,
  EventDto,
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
      'e.currency',
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
  currency: r.currency.trim(),
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

async function getEventDetail(id: string): Promise<z.infer<typeof EventDetailDto>> {
  const [event, stats] = await Promise.all([
    selectEvents(db).where('e.id', '=', id).executeTakeFirst(),
    db
      .selectFrom('eventSeats')
      .where('eventId', '=', id)
      .select((eb) => [
        eb.fn.countAll<number>().as('total'),
        eb.fn.count<number>('id').filterWhere('status', '=', 'available').as('available'),
        eb.fn.min('priceCents').as('minCents'),
        eb.fn.max('priceCents').as('maxCents'),
      ])
      .executeTakeFirstOrThrow(),
  ]);
  if (!event) throw notFound('Event');

  return {
    ...toEventDto(event),
    seats: { total: stats.total, available: stats.available },
    priceRange:
      stats.minCents === null ? null : { minCents: stats.minCents, maxCents: stats.maxCents! },
  };
}

/** Postgres raises 23P01 when the events_no_venue_overlap exclusion constraint fires. */
function isVenueOverlap(err: unknown) {
  return (
    typeof err === 'object' && err !== null &&
    (err as { code?: string }).code === '23P01' &&
    (err as { constraint?: string }).constraint === 'events_no_venue_overlap'
  );
}

const venueOverlap = () =>
  conflict('VENUE_TIME_CONFLICT', 'The venue already has an event overlapping this time slot');

export const eventRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/events',
    {
      schema: {
        tags: ['events'],
        summary: 'Create an event (as a draft) and its seat inventory',
        body: CreateEventBody,
        response: { 201: EventDetailDto, ...errors },
      },
    },
    async (req, reply) => {
      const { pricing, organizerId, venueId, ...fields } = req.body;

      const organizer = await db
        .selectFrom('users')
        .select('role')
        .where('id', '=', organizerId)
        .executeTakeFirst();
      if (!organizer) throw unprocessable('ORGANIZER_NOT_FOUND', 'Organizer does not exist');
      if (organizer.role === 'attendee') {
        // Becomes a 403 in Phase 2, when this is decided by the caller's token.
        throw unprocessable('NOT_AN_ORGANIZER', 'User is not an organizer');
      }

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
        eventId = await db.transaction().execute(async (trx) => {
          const { id } = await trx
            .insertInto('events')
            .values({
              ...fields,
              organizerId,
              venueId,
              startsAt: new Date(fields.startsAt),
              endsAt: new Date(fields.endsAt),
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
        .send(await getEventDetail(eventId));
    },
  );

  app.get(
    '/events',
    {
      schema: {
        tags: ['events'],
        summary: 'Search and list events (cursor pagination, ordered by start time)',
        querystring: ListEventsQuery,
        response: { 200: EventListResponse, ...errors },
      },
    },
    async (req) => {
      const { q, city, category, venueId, organizerId, status, from, to, limit, cursor } = req.query;

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
        query = query.where(sql<boolean>`(e.starts_at, e.id) > (${c.startsAt}::timestamptz, ${c.id}::uuid)`);
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
          nextCursor: hasMore && last ? encodeCursor({ startsAt: last.startsAt, id: last.id }) : null,
        },
      };
    },
  );

  app.get(
    '/events/:id',
    {
      schema: {
        tags: ['events'],
        summary: 'Get an event with seat availability and price range',
        params: IdParams,
        response: { 200: EventDetailDto, ...errors },
      },
    },
    async (req) => getEventDetail(req.params.id),
  );

  app.patch(
    '/events/:id',
    {
      schema: {
        tags: ['events'],
        summary: 'Update an event or change its status',
        description: `Status transitions: ${Object.entries(STATUS_TRANSITIONS)
          .map(([from, to]) => `${from} → ${to.length ? to.join(' | ') : '(final)'}`)
          .join('; ')}. Cancelled events cannot be edited.`,
        params: IdParams,
        body: UpdateEventBody,
        response: { 200: EventDetailDto, ...errors },
      },
    },
    async (req) => {
      const { id } = req.params;
      const patch = req.body;

      try {
        await db.transaction().execute(async (trx) => {
          // FOR UPDATE locks the row until commit, so two concurrent PATCHes can't both read
          // "draft" and apply conflicting transitions. Phase 3 relies on this same lock.
          const current = await trx
            .selectFrom('events')
            .select(['status', 'startsAt', 'endsAt'])
            .where('id', '=', id)
            .forUpdate()
            .executeTakeFirst();
          if (!current) throw notFound('Event');

          if (current.status === 'cancelled') {
            throw conflict('EVENT_CANCELLED', 'Cancelled events cannot be modified');
          }
          if (patch.status && patch.status !== current.status &&
              !STATUS_TRANSITIONS[current.status].includes(patch.status)) {
            throw conflict(
              'INVALID_STATUS_TRANSITION',
              `Cannot change status from ${current.status} to ${patch.status}`,
              { allowed: STATUS_TRANSITIONS[current.status] },
            );
          }

          const startsAt = patch.startsAt ? new Date(patch.startsAt) : current.startsAt;
          const endsAt = patch.endsAt ? new Date(patch.endsAt) : current.endsAt;
          if (endsAt <= startsAt) {
            throw new AppError(400, 'VALIDATION_ERROR', 'endsAt must be after startsAt');
          }

          await trx
            .updateTable('events')
            .set({ ...patch, startsAt, endsAt })
            .where('id', '=', id)
            .execute();
        });
      } catch (err) {
        if (isVenueOverlap(err)) throw venueOverlap();
        throw err;
      }

      return getEventDetail(id);
    },
  );

  app.delete(
    '/events/:id',
    {
      schema: {
        tags: ['events'],
        summary: 'Delete a draft event',
        description: 'Only drafts can be deleted. Published events must be cancelled instead, which keeps their history.',
        params: IdParams,
        response: { 204: z.null().describe('Deleted'), ...errors },
      },
    },
    async (req, reply) => {
      const deleted = await db
        .deleteFrom('events')
        .where('id', '=', req.params.id)
        .where('status', '=', 'draft')
        .returning('id')
        .executeTakeFirst();

      if (!deleted) {
        const exists = await db
          .selectFrom('events')
          .select('status')
          .where('id', '=', req.params.id)
          .executeTakeFirst();
        if (!exists) throw notFound('Event');
        throw conflict('EVENT_NOT_DRAFT', `Only draft events can be deleted (status is ${exists.status}); cancel it instead`);
      }
      return reply.status(204).send(null);
    },
  );

  app.get(
    '/events/:id/seats',
    {
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
        .select(['id', 'currency'])
        .where('id', '=', req.params.id)
        .executeTakeFirst();
      if (!event) throw notFound('Event');

      const rows = await db
        .selectFrom('eventSeats as es')
        .innerJoin('venueSeats as vs', 'vs.id', 'es.venueSeatId')
        .innerJoin('venueSections as sec', 'sec.id', 'vs.sectionId')
        .where('es.eventId', '=', event.id)
        .select([
          'es.id',
          'es.priceCents',
          'es.status',
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
        });
      }

      return { eventId: event.id, currency: event.currency.trim(), sections: [...sections.values()] };
    },
  );
};
