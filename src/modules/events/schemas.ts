import { z } from 'zod';
import {
  EVENT_CATEGORIES,
  EVENT_STATUSES,
  POSTER_STATUSES,
  SEAT_STATUSES,
  type EventStatus,
  type PosterStatus,
  type PosterVariants,
} from '../../db/types.js';
import { Limit, Timestamp, TimestampInput } from '../../lib/schemas.js';
import { publicUrl } from '../../lib/storage.js';

/** Allowed status changes. Anything not listed here is rejected with 409. */
export const STATUS_TRANSITIONS: Record<EventStatus, readonly EventStatus[]> = {
  draft: ['published', 'cancelled'],
  published: ['cancelled'],
  cancelled: [],
};

export const PosterDto = z
  .object({
    status: z.enum(POSTER_STATUSES),
    urls: z
      .object({ small: z.url(), medium: z.url(), large: z.url() })
      .nullable()
      .describe('WebP variants 320/640/1280 px wide; null until processing finishes'),
    error: z.string().nullable(),
  })
  .meta({ id: 'Poster' });

export function posterDto(
  status: PosterStatus | null,
  variants: PosterVariants | null,
  error: string | null,
): z.infer<typeof PosterDto> | null {
  if (!status) return null;
  const urls =
    status === 'ready' && variants?.['320'] && variants['640'] && variants['1280']
      ? {
          small: publicUrl(variants['320']),
          medium: publicUrl(variants['640']),
          large: publicUrl(variants['1280']),
        }
      : null;
  return { status, urls, error };
}

export const EventDto = z
  .object({
    id: z.uuid(),
    organizerId: z.uuid(),
    venue: z.object({
      id: z.uuid(),
      name: z.string(),
      city: z.string(),
      timezone: z.string().describe('IANA time zone: show the event times in it'),
    }),
    title: z.string(),
    description: z.string(),
    category: z.enum(EVENT_CATEGORIES),
    status: z.enum(EVENT_STATUSES),
    startsAt: Timestamp,
    endsAt: Timestamp,
    salesStartAt: Timestamp.nullable().describe('When tickets go on sale; null = as soon as published'),
    maxTicketsPerUser: z.int(),
    currency: z.string(),
    poster: PosterDto.nullable(),
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

const salesBeforeStart = (b: { startsAt?: string; salesStartAt?: string | null }) =>
  !b.startsAt || !b.salesStartAt || new Date(b.salesStartAt) < new Date(b.startsAt);

const MaxTicketsPerUser = z.int().min(1).max(50);

export const CreateEventBody = z
  .object({
    venueId: z.uuid(),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(5000).default(''),
    category: z.enum(EVENT_CATEGORIES),
    startsAt: TimestampInput,
    endsAt: TimestampInput,
    salesStartAt: TimestampInput.optional().describe(
      'Omit to put tickets on sale as soon as the event is published',
    ),
    maxTicketsPerUser: MaxTicketsPerUser.default(10),
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
  .refine(salesBeforeStart, { path: ['salesStartAt'], message: 'salesStartAt must be before startsAt' })
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
    salesStartAt: TimestampInput.nullable(),
    maxTicketsPerUser: MaxTicketsPerUser,
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
  status: z
    .enum(EVENT_STATUSES)
    .default('published')
    .describe('draft requires auth: organizers see their own drafts, admins see all'),
  from: TimestampInput.optional().describe('Only events starting at or after this time (default: now)'),
  to: TimestampInput.optional().describe('Only events starting before this time'),
  onSale: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional()
    .describe('Only events you can book now: published, upcoming, sales open, and with seats for sale'),
  limit: Limit,
  cursor: z.string().optional().describe("Opaque cursor from the previous page's `page.nextCursor`"),
});

export const EventListItem = EventDto.extend({
  seats: z
    .object({ total: z.int(), available: z.int() })
    .describe('Approximate (lists are cached for up to 30 s); the seat map has live counts'),
  priceRange: z.object({ minCents: z.int(), maxCents: z.int() }).nullable(),
}).meta({ id: 'EventListItem' });

export const EventListResponse = z.object({
  data: z.array(EventListItem),
  page: z.object({ limit: z.int(), nextCursor: z.string().nullable() }),
});

export const SeatMapResponse = z
  .object({
    eventId: z.uuid(),
    currency: z.string(),
    generatedAt: Timestamp.describe(
      'When this snapshot was taken (it may be up to ~1 s old). Live changes stream over GET /events/:id/live.',
    ),
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
            version: z.int().describe('Bumped on every change; live updates with a lower version are stale'),
          }),
        ),
      }),
    ),
  })
  .meta({ id: 'SeatMap' });
