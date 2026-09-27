import { z } from 'zod';
import { sql } from 'kysely';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { db } from '../../db/index.js';
import type { Venue } from '../../db/types.js';
import { notFound } from '../../lib/errors.js';
import { escapeLike } from '../../lib/pagination.js';
import { errors, IdParams, Limit, Timestamp } from '../../lib/schemas.js';
import { generateSeats } from './layout.js';

const MAX_SEATS_PER_VENUE = 50_000;

export const VenueDto = z
  .object({
    id: z.uuid(),
    name: z.string(),
    address: z.string(),
    city: z.string(),
    country: z.string(),
    capacity: z.int(),
    createdAt: Timestamp,
  })
  .meta({ id: 'Venue' });

const VenueDetailDto = VenueDto.extend({
  sections: z.array(z.object({ id: z.uuid(), name: z.string(), rows: z.int(), seats: z.int() })),
}).meta({ id: 'VenueDetail' });

const toVenueDto = (v: Venue): z.infer<typeof VenueDto> => ({
  id: v.id,
  name: v.name,
  address: v.address,
  city: v.city,
  country: v.country,
  capacity: v.capacity,
  createdAt: v.createdAt.toISOString(),
});

const SectionSpec = z.object({
  name: z.string().trim().min(1).max(50),
  rows: z.int().min(1).max(100),
  seatsPerRow: z.int().min(1).max(200),
});

const CreateVenueBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    address: z.string().trim().min(1).max(300),
    city: z.string().trim().min(1).max(100),
    country: z.string().regex(/^[A-Z]{2}$/, 'Must be an ISO 3166-1 alpha-2 code, e.g. "US"'),
    sections: z.array(SectionSpec).min(1).max(50),
  })
  .superRefine((body, ctx) => {
    const names = body.sections.map((s) => s.name.toLowerCase());
    if (new Set(names).size !== names.length) {
      ctx.addIssue({ code: 'custom', path: ['sections'], message: 'Section names must be unique' });
    }
    const total = body.sections.reduce((n, s) => n + s.rows * s.seatsPerRow, 0);
    if (total > MAX_SEATS_PER_VENUE) {
      ctx.addIssue({
        code: 'custom',
        path: ['sections'],
        message: `A venue can have at most ${MAX_SEATS_PER_VENUE} seats (got ${total})`,
      });
    }
  });

const ListVenuesQuery = z.object({
  q: z.string().trim().min(1).max(100).optional().describe('Substring match on venue name'),
  city: z.string().trim().min(1).max(100).optional().describe('Exact city, case-insensitive'),
  limit: Limit,
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

export const venueRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/venues',
    {
      schema: {
        tags: ['venues'],
        summary: 'Create a venue and generate its seat layout',
        description:
          'The layout is immutable after creation, because events copy it into their own seat inventory.',
        body: CreateVenueBody,
        response: { 201: VenueDto, ...errors },
      },
    },
    async (req, reply) => {
      const { sections, ...fields } = req.body;
      const seats = generateSeats(sections);

      // One transaction: either the venue, its sections and every seat exist, or nothing does.
      const venue = await db.transaction().execute(async (trx) => {
        const venue = await trx
          .insertInto('venues')
          .values({ ...fields, capacity: seats.length })
          .returningAll()
          .executeTakeFirstOrThrow();

        const insertedSections = await trx
          .insertInto('venueSections')
          .values(sections.map((s, i) => ({ venueId: venue.id, name: s.name, sortOrder: i })))
          .returning(['id', 'name'])
          .execute();
        const sectionId = new Map(insertedSections.map((s) => [s.name, s.id]));

        // One INSERT ... SELECT FROM unnest(arrays) instead of thousands of single-row
        // inserts. It avoids both the round trips and the 65,535 bind-parameter limit.
        await sql`
          INSERT INTO venue_seats (section_id, row_label, seat_number, x, y)
          SELECT * FROM unnest(
            ${seats.map((s) => sectionId.get(s.section))}::uuid[],
            ${seats.map((s) => s.rowLabel)}::text[],
            ${seats.map((s) => s.seatNumber)}::int[],
            ${seats.map((s) => s.x)}::int[],
            ${seats.map((s) => s.y)}::int[]
          )
        `.execute(trx);

        return venue;
      });

      return reply.status(201).header('location', `/api/v1/venues/${venue.id}`).send(toVenueDto(venue));
    },
  );

  app.get(
    '/venues',
    {
      schema: {
        tags: ['venues'],
        summary: 'List venues (offset pagination)',
        querystring: ListVenuesQuery,
        response: {
          200: z.object({
            data: z.array(VenueDto),
            page: z.object({ limit: z.int(), offset: z.int(), total: z.int() }),
          }),
          ...errors,
        },
      },
    },
    async (req) => {
      const { q, city, limit, offset } = req.query;

      let base = db.selectFrom('venues');
      if (q) base = base.where('name', 'ilike', `%${escapeLike(q)}%`);
      if (city) base = base.where(sql`lower(city)`, '=', city.toLowerCase());

      // Offset pagination is fine for a small table where clients want "page 3 of 12".
      // For large, fast-changing lists, see the keyset pagination on /events.
      const [rows, { total }] = await Promise.all([
        base.selectAll().orderBy('name').orderBy('id').limit(limit).offset(offset).execute(),
        base.select((eb) => eb.fn.countAll<number>().as('total')).executeTakeFirstOrThrow(),
      ]);

      return { data: rows.map(toVenueDto), page: { limit, offset, total } };
    },
  );

  app.get(
    '/venues/:id',
    {
      schema: {
        tags: ['venues'],
        summary: 'Get a venue with its sections',
        params: IdParams,
        response: { 200: VenueDetailDto, ...errors },
      },
    },
    async (req) => {
      const venue = await db
        .selectFrom('venues')
        .selectAll()
        .where('id', '=', req.params.id)
        .executeTakeFirst();
      if (!venue) throw notFound('Venue');

      const sections = await db
        .selectFrom('venueSections as sec')
        .innerJoin('venueSeats as vs', 'vs.sectionId', 'sec.id')
        .where('sec.venueId', '=', venue.id)
        .groupBy(['sec.id', 'sec.name', 'sec.sortOrder'])
        .orderBy('sec.sortOrder')
        .select((eb) => [
          'sec.id',
          'sec.name',
          eb.fn.count<number>(sql`DISTINCT vs.row_label`).as('rows'),
          eb.fn.countAll<number>().as('seats'),
        ])
        .execute();

      return { ...toVenueDto(venue), sections };
    },
  );
};
