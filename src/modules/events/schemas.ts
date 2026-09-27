import { z } from 'zod';
import { EVENT_CATEGORIES, EVENT_STATUSES, SEAT_STATUSES, type EventStatus } from '../../db/types.js';
import { Limit, Timestamp, TimestampInput } from '../../lib/schemas.js';

/** Allowed status changes. Anything not listed here is rejected with 409. */
export const STATUS_TRANSITIONS: Record<EventStatus, readonly EventStatus[]> = {
  draft: ['published', 'cancelled'],
  published: ['cancelled'],
  cancelled: [],
};

export const EventDto = z
  .object({
    id: z.uuid(),
    organizerId: z.uuid(),
    venue: z.object({ id: z.uuid(), name: z.string(), city: z.string() }),
    title: z.string(),
    description: z.string(),
    category: z.enum(EVENT_CATEGORIES),
    status: z.enum(EVENT_STATUSES),
    startsAt: Timestamp,
    endsAt: Timestamp,
    currency: z.string(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: 'Event' });

export const EventDetailDto = EventDto.extend({
  seats: z.object({ total: z.int(), available: z.int() }),
  priceRange: z.object({ minCents: z.int(), maxCents: z.int() }).nullable(),
}).meta({ id: 'EventDetail' });

const endsAfterStart = (b: { startsAt?: string; endsAt?: string }) =>
  !b.startsAt || !b.endsAt || new Date(b.endsAt) > new Date(b.startsAt);

export const CreateEventBody = z
  .object({
    // TEMPORARY: in Phase 2 the organizer comes from the access token, not the body.
    organizerId: z.uuid(),
    venueId: z.uuid(),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(5000).default(''),
    category: z.enum(EVENT_CATEGORIES),
    startsAt: TimestampInput,
    endsAt: TimestampInput,
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, 'ISO 4217 code, e.g. "USD"')
      .default('USD'),
    pricing: z
      .array(z.object({ section: z.string().min(1), priceCents: z.int().min(0).max(10_000_000) }))
      .min(1)
      .describe('One price per venue section. Every section must be priced.'),
  })
  .refine(endsAfterStart, { path: ['endsAt'], message: 'endsAt must be after startsAt' })
  .refine((b) => new Date(b.startsAt) > new Date(), {
    path: ['startsAt'],
    message: 'startsAt must be in the future',
  });

export const UpdateEventBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(5000),
    category: z.enum(EVENT_CATEGORIES),
    startsAt: TimestampInput,
    endsAt: TimestampInput,
    status: z.enum(EVENT_STATUSES),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update' })
  .refine(endsAfterStart, { path: ['endsAt'], message: 'endsAt must be after startsAt' });

export const ListEventsQuery = z.object({
  q: z.string().trim().min(1).max(100).optional().describe('Full-text search over title and description'),
  city: z.string().trim().min(1).max(100).optional(),
  category: z.enum(EVENT_CATEGORIES).optional(),
  venueId: z.uuid().optional(),
  organizerId: z.uuid().optional(),
  status: z.enum(EVENT_STATUSES).default('published'),
  from: TimestampInput.optional().describe('Only events starting at or after this time (default: now)'),
  to: TimestampInput.optional().describe('Only events starting before this time'),
  limit: Limit,
  cursor: z.string().optional().describe("Opaque cursor from the previous page's `page.nextCursor`"),
});

export const EventListResponse = z.object({
  data: z.array(EventDto),
  page: z.object({ limit: z.int(), nextCursor: z.string().nullable() }),
});

export const SeatMapResponse = z
  .object({
    eventId: z.uuid(),
    currency: z.string(),
    sections: z.array(
      z.object({
        name: z.string(),
        seats: z.array(
          z.object({
            id: z.int(),
            row: z.string(),
            number: z.int(),
            x: z.int(),
            y: z.int(),
            priceCents: z.int(),
            status: z.enum(SEAT_STATUSES),
          }),
        ),
      }),
    ),
  })
  .meta({ id: 'SeatMap' });
