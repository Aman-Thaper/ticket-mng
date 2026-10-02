import { createHash } from 'node:crypto';
import { z } from 'zod';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { config } from '../../config.js';
import { db } from '../../db/index.js';
import { withTransaction } from '../../db/transaction.js';
import { enqueue } from '../../jobs/outbox.js';
import type { DB, SeatStatus } from '../../db/types.js';
import { AppError, conflict, forbidden, notFound, unauthorized, unprocessable } from '../../lib/errors.js';
import { acquirableSql, cancelPendingBookingsForEvent } from '../bookings/service.js';
import { bumpGenerations, generationKey, invalidate, MicroCache, readThrough } from '../../lib/cache.js';
import { sendCachedJson } from '../../lib/http-cache.js';
import { stableStringify } from '../../lib/json.js';
import { logger } from '../../lib/logger.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';
import { errors, IdParams } from '../../lib/schemas.js';
import { mostViewed } from '../../realtime/viewers.js';
import { bearerAuth, currentUser, optionalAuth, requireRole, type AuthUser } from '../auth/guard.js';
import { assertCanManage, isVisible } from './access.js';
import { liveStats, soldLastHour } from './live.js';
import { posterDto, type EventDto } from './schemas.js';
import {
  CreateEventBody,
  EventDetailDto,
  EventListResponse,
  ListEventsQuery,
  SeatMapResponse,
  STATUS_TRANSITIONS,
  TrendingQuery,
  TrendingResponse,
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
      'v.timezone as venueTimezone',
    ]);
}

type EventRow = Awaited<ReturnType<ReturnType<typeof selectEvents>['executeTakeFirstOrThrow']>>;

const toEventDto = (r: EventRow): z.infer<typeof EventDto> => ({
  id: r.id,
  organizerId: r.organizerId,
  venue: { id: r.venueId, name: r.venueName, city: r.venueCity, timezone: r.venueTimezone },
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

// ─── read side: caching (see lib/cache.ts for the two strategies) ─────────────────────────

type EventDetail = z.infer<typeof EventDetailDto>;
type StaticEvent = Omit<EventDetail, 'seats' | 'live'>;

/**
 * Everything about an event except the live numbers (availability, viewers, recent sales):
 * cached in Redis, and invalidated through the event's generation counter whenever the event
 * is written.
 */
async function loadStaticEvent(id: string): Promise<StaticEvent | null> {
  const { body } = await readThrough('event', `event:${id}`, [generationKey.event(id)], 300, async () => {
    const [event, prices] = await Promise.all([
      selectEvents(db).where('e.id', '=', id).executeTakeFirst(),
      db
        .selectFrom('eventSeats')
        .where('eventId', '=', id)
        .select((eb) => [eb.fn.min('priceCents').as('minCents'), eb.fn.max('priceCents').as('maxCents')])
        .executeTakeFirstOrThrow(),
    ]);
    if (!event) return 'null'; // cache the miss too, so a flood of bad ids can't bypass the cache
    const detail: StaticEvent = {
      ...toEventDto(event),
      priceRange: prices.minCents === null ? null : { minCents: prices.minCents, maxCents: prices.maxCents },
    };
    return JSON.stringify(detail);
  });
  return JSON.parse(body) as StaticEvent | null;
}

/** Live availability changes with every hold: in-process micro-cache (1 s), never invalidated. */
const availabilityCache = new MicroCache('seat-counts', config.MICRO_CACHE_TTL_MS);

async function availability(id: string): Promise<EventDetail['seats']> {
  const { body } = await availabilityCache.get(id, async () => {
    const counts = await db
      .selectFrom('eventSeats as es')
      .leftJoin('bookings as b', 'b.id', 'es.bookingId')
      .where('es.eventId', '=', id)
      .select((eb) => [
        eb.fn.countAll<number>().as('total'),
        // Seats of lapsed holds count as available, whether or not the expiry job has run.
        sql<number>`count(*) FILTER (WHERE ${acquirableSql})`.as('available'),
      ])
      .executeTakeFirstOrThrow();
    return JSON.stringify({ total: counts.total, available: counts.available });
  });
  return JSON.parse(body) as EventDetail['seats'];
}

async function getEventDetail(id: string, viewer: AuthUser | null): Promise<EventDetail> {
  const event = await loadStaticEvent(id);
  // The visibility check runs on every request, cache hit or not.
  if (!event || !isVisible(event, viewer)) throw notFound('Event');
  const [seats, live] = await Promise.all([availability(id), liveStats(id)]);
  return { ...event, seats, live };
}

/** Seat maps are the hottest read of an on-sale: in-process, 1 s, single-flight. */
const seatMapCache = new MicroCache('seat-map', config.MICRO_CACHE_TTL_MS, 200);

async function buildSeatMap(eventId: string, currency: string): Promise<string> {
  const rows = await db
    .selectFrom('eventSeats as es')
    .innerJoin('venueSeats as vs', 'vs.id', 'es.venueSeatId')
    .innerJoin('venueSections as sec', 'sec.id', 'vs.sectionId')
    .leftJoin('bookings as b', 'b.id', 'es.bookingId')
    .where('es.eventId', '=', eventId)
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
  const map: z.infer<typeof SeatMapResponse> = {
    eventId,
    currency,
    generatedAt: new Date().toISOString(),
    sections: [...sections.values()],
  };
  return JSON.stringify(map);
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

type ListQuery = z.infer<typeof ListEventsQuery>;

/**
 * Seat counts and price range for a page of events, in one grouped query. "Available" here is
 * a plain status count (a lapsed hold counts as taken until it's swept, within 30 s): close
 * enough for "Selling fast" on a card. The event page shows exact, live numbers.
 */
async function seatStats(eventIds: string[]) {
  if (!eventIds.length) return new Map<string, never>();
  const rows = await db
    .selectFrom('eventSeats')
    .where('eventId', 'in', eventIds)
    .groupBy('eventId')
    .select((eb) => [
      'eventId',
      eb.fn.countAll<number>().as('total'),
      sql<number>`count(*) FILTER (WHERE status = 'available')`.as('available'),
      eb.fn.min('priceCents').as('minCents'),
      eb.fn.max('priceCents').as('maxCents'),
    ])
    .execute();
  return new Map(rows.map((r) => [r.eventId, r]));
}

type SeatStats = { total: number; available: number; minCents: number; maxCents: number };

/** An event as it appears in lists: the event, approximate seat counts and its price range. */
const toListItem = (r: EventRow, s: SeatStats | undefined) => ({
  ...toEventDto(r),
  seats: { total: s?.total ?? 0, available: s?.available ?? 0 },
  priceRange: s ? { minCents: s.minCents, maxCents: s.maxCents } : null,
});

async function listEvents({
  q,
  city,
  category,
  venueId,
  organizerId,
  status,
  from,
  to,
  onSale,
  limit,
  cursor,
}: ListQuery) {
  let query = selectEvents(db).where('e.status', '=', onSale ? 'published' : status);
  if (q) query = query.where(sql<boolean>`e.search @@ websearch_to_tsquery('english', ${q})`);
  if (city) query = query.where(sql`lower(v.city)`, '=', city.toLowerCase());
  if (category) query = query.where('e.category', '=', category);
  if (venueId) query = query.where('e.venueId', '=', venueId);
  if (organizerId) query = query.where('e.organizerId', '=', organizerId);
  // Upcoming events by default. Pass an earlier `from` to include past ones.
  query = query.where('e.startsAt', '>=', from ? new Date(from) : new Date());
  if (to) query = query.where('e.startsAt', '<', new Date(to));
  if (onSale) {
    // Bookable right now: ticket sales have opened, and the event has seats to sell.
    query = query
      .where((eb) => eb.or([eb('e.salesStartAt', 'is', null), eb('e.salesStartAt', '<=', sql<Date>`now()`)]))
      .where(sql<boolean>`EXISTS (SELECT 1 FROM event_seats es WHERE es.event_id = e.id)`);
  }
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
  const stats = await seatStats(page.map((r) => r.id));
  return {
    data: page.map((r) => toListItem(r, stats.get(r.id))),
    page: { limit, nextCursor: hasMore && last ? encodeCursor({ at: last.startsAt, id: last.id }) : null },
  };
}

/**
 * "Trending now": upcoming events with the most people viewing them right now (see
 * realtime/viewers.ts), ties broken by tickets sold in the last hour. Redis says which
 * events are being watched; Postgres fills in the cards.
 */
async function trending(limit: number): Promise<z.infer<typeof TrendingResponse>> {
  let watched: Awaited<ReturnType<typeof mostViewed>>;
  try {
    // Over-fetch: some watched events may have ended or been cancelled since.
    watched = await mostViewed(limit * 3);
  } catch (err) {
    logger.warn({ err }, 'viewer counts unavailable; no trending events');
    return { data: [] };
  }
  if (!watched.length) return { data: [] };
  const ids = watched.map((w) => w.eventId);
  const [rows, stats, sold] = await Promise.all([
    selectEvents(db)
      .where('e.id', 'in', ids)
      .where('e.status', '=', 'published')
      .where('e.startsAt', '>=', new Date())
      .execute(),
    seatStats(ids),
    soldLastHour(ids),
  ]);
  const viewers = new Map(watched.map((w) => [w.eventId, w.viewers]));
  return {
    data: rows
      .map((r) => ({
        ...toListItem(r, stats.get(r.id)),
        live: { viewers: viewers.get(r.id) ?? 0, soldLastHour: sold.get(r.id) ?? 0 },
      }))
      .sort((a, b) => b.live.viewers - a.live.viewers || b.live.soldLastHour - a.live.soldLastHour)
      .slice(0, limit),
  };
}

/** The same list for everyone, and it moves every few seconds: micro-cached, like seat maps. */
const trendingCache = new MicroCache('trending', config.MICRO_CACHE_TTL_MS, 20);

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

          invalidate(generationKey.eventLists);
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
    async (req, reply) => {
      const query = req.query;
      let { organizerId } = query;

      if (query.status === 'draft') {
        const user = req.user;
        if (!user) throw unauthorized();
        if (user.role === 'attendee') throw forbidden('Only organizers can list drafts');
        if (user.role === 'organizer') {
          if (organizerId && organizerId !== user.id) throw forbidden('You can only list your own drafts');
          organizerId = user.id;
        }
        // Drafts depend on who's asking: never cached.
        return listEvents({ ...query, organizerId });
      }

      // Public listings are the same for everyone: cache them in Redis (30 s) under the
      // event-lists generation, and let browsers and CDNs keep them for 5 s.
      const key = `events:list:${createHash('sha1').update(stableStringify(query)).digest('base64url')}`;
      const cached = await readThrough('event-list', key, [generationKey.eventLists], 30, async () =>
        JSON.stringify(await listEvents(query)),
      );
      return sendCachedJson(req, reply, cached, 'public, max-age=5');
    },
  );

  app.get(
    '/events/trending',
    {
      schema: {
        tags: ['events'],
        summary: 'Events people are viewing right now, most viewers first',
        description:
          'Upcoming published events with their live viewer counts and tickets sold in the last hour. ' +
          'Empty when nobody is viewing anything.',
        querystring: TrendingQuery,
        response: { 200: TrendingResponse, ...errors },
      },
    },
    async (req, reply) => {
      const { limit } = req.query;
      const cached = await trendingCache.get(String(limit), async () =>
        JSON.stringify(await trending(limit)),
      );
      return sendCachedJson(req, reply, cached, 'public, max-age=5');
    },
  );

  app.get(
    '/events/:id',
    {
      onRequest: optionalAuth,
      schema: {
        tags: ['events'],
        summary: 'Get an event with seat availability, price range, and live viewers and sales',
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
          invalidate(generationKey.event(id), generationKey.eventLists);

          // Cancelling the event voids every seat hold on it, and queues refunds for every paid
          // booking (a job, since a big show can have thousands).
          if (patch.status === 'cancelled') {
            await cancelPendingBookingsForEvent(trx, id);
            await enqueue(trx, 'payments', 'refund-event', { eventId: id }, { jobId: `refund-event_${id}` });
          }
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
      await bumpGenerations(generationKey.event(req.params.id), generationKey.eventLists);
      return reply.status(204).send(null);
    },
  );

  app.get(
    '/events/:id/live',
    {
      websocket: true,
      schema: {
        tags: ['events'],
        summary: 'Live seat updates (WebSocket)',
        description:
          'Connect with a WebSocket. The server sends {"type":"hello"} once subscribed; load GET /events/:id/seats after that, ' +
          'then apply {"type":"seats","seats":[[seatId, status, version], ...]} messages, ignoring any seat update whose ' +
          'version is not newer than what you have. Updates are batched (~100 ms). ' +
          '{"type":"viewers","count":N} reports how many people are watching the event, whenever that changes (checked every ~5 s). ' +
          'Close code 1001/1013: reconnect.',
        params: IdParams,
      },
    },
    async (socket, req) => {
      // No auth over WebSockets (browsers can't set headers on them), so only public events stream.
      const event = await loadStaticEvent(req.params.id);
      if (!event || event.status === 'draft') {
        socket.close(4404, 'Event not found');
        return;
      }
      if (await app.liveHub.join(event.id, socket)) {
        socket.send(
          JSON.stringify({ type: 'hello', eventId: event.id, serverTime: new Date().toISOString() }),
        );
        // Other viewers hear about a change at the next report; a newcomer gets the count now.
        const viewers = app.liveHub.lastViewerCount(event.id);
        if (viewers !== undefined) {
          socket.send(JSON.stringify({ type: 'viewers', eventId: event.id, count: viewers }));
        }
      }
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
    async (req, reply) => {
      const event = await loadStaticEvent(req.params.id);
      if (!event || !isVisible(event, req.user)) throw notFound('Event');
      const cached = await seatMapCache.get(event.id, () => buildSeatMap(event.id, event.currency));
      // no-cache: clients may store it but must revalidate; an unchanged map costs a 304.
      return sendCachedJson(req, reply, cached, 'no-cache');
    },
  );
};
