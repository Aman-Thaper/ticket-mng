import { z } from 'zod';
import { db } from '../../db/index.js';
import { BOOKING_STATUSES } from '../../db/types.js';
import { notFound } from '../../lib/errors.js';
import { Timestamp } from '../../lib/schemas.js';
import type { AuthUser } from '../auth/guard.js';

export const BookingDto = z
  .object({
    id: z.uuid(),
    status: z.enum(BOOKING_STATUSES),
    userId: z.uuid(),
    event: z.object({ id: z.uuid(), title: z.string(), startsAt: Timestamp, venueName: z.string() }),
    items: z.array(
      z.object({
        seatId: z.int(),
        section: z.string(),
        row: z.string(),
        number: z.int(),
        priceCents: z.int(),
      }),
    ),
    totalCents: z.int(),
    currency: z.string(),
    expiresAt: Timestamp.describe('End of the seat hold. After this, an unpaid booking expires.'),
    createdAt: Timestamp,
    confirmedAt: Timestamp.nullable(),
    cancelledAt: Timestamp.nullable(),
    expiredAt: Timestamp.nullable(),
    refundedAt: Timestamp.nullable(),
  })
  .meta({ id: 'Booking' });

export type BookingDtoType = z.infer<typeof BookingDto>;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function selectBookings() {
  return db
    .selectFrom('bookings as b')
    .innerJoin('events as e', 'e.id', 'b.eventId')
    .innerJoin('venues as v', 'v.id', 'e.venueId')
    .select([
      'b.id',
      'b.status',
      'b.userId',
      'b.totalCents',
      'b.currency',
      'b.expiresAt',
      'b.createdAt',
      'b.confirmedAt',
      'b.cancelledAt',
      'b.expiredAt',
      'b.refundedAt',
      'e.id as eventId',
      'e.title as eventTitle',
      'e.startsAt as eventStartsAt',
      'e.organizerId',
      'v.name as venueName',
    ]);
}

type BookingRow = Awaited<ReturnType<ReturnType<typeof selectBookings>['executeTakeFirstOrThrow']>>;

async function itemsFor(bookingIds: string[]) {
  if (!bookingIds.length) return new Map<string, BookingDtoType['items']>();
  const rows = await db
    .selectFrom('bookingItems as bi')
    .innerJoin('eventSeats as es', 'es.id', 'bi.eventSeatId')
    .innerJoin('venueSeats as vs', 'vs.id', 'es.venueSeatId')
    .innerJoin('venueSections as sec', 'sec.id', 'vs.sectionId')
    .select([
      'bi.bookingId',
      'bi.eventSeatId',
      'bi.priceCents',
      'sec.name as section',
      'vs.rowLabel',
      'vs.seatNumber',
    ])
    .where('bi.bookingId', 'in', bookingIds)
    .orderBy('sec.sortOrder')
    .orderBy('vs.y')
    .orderBy('vs.x')
    .execute();

  const byBooking = new Map<string, BookingDtoType['items']>();
  for (const r of rows) {
    const list = byBooking.get(r.bookingId) ?? [];
    list.push({
      seatId: r.eventSeatId,
      section: r.section,
      row: r.rowLabel,
      number: r.seatNumber,
      priceCents: r.priceCents,
    });
    byBooking.set(r.bookingId, list);
  }
  return byBooking;
}

function toDto(b: BookingRow, items: BookingDtoType['items']): BookingDtoType {
  return {
    id: b.id,
    status: b.status,
    userId: b.userId,
    event: {
      id: b.eventId,
      title: b.eventTitle,
      startsAt: b.eventStartsAt.toISOString(),
      venueName: b.venueName,
    },
    items,
    totalCents: b.totalCents,
    currency: b.currency.trim(),
    expiresAt: b.expiresAt.toISOString(),
    createdAt: b.createdAt.toISOString(),
    confirmedAt: iso(b.confirmedAt),
    cancelledAt: iso(b.cancelledAt),
    expiredAt: iso(b.expiredAt),
    refundedAt: iso(b.refundedAt),
  };
}

/** Buyer, admin, or the organizer of the event may see a booking. Anyone else gets 404. */
export async function getBookingFor(viewer: AuthUser, bookingId: string): Promise<BookingDtoType> {
  const booking = await selectBookings().where('b.id', '=', bookingId).executeTakeFirst();
  const visible =
    booking && (viewer.role === 'admin' || booking.userId === viewer.id || booking.organizerId === viewer.id);
  if (!visible) throw notFound('Booking');
  const items = await itemsFor([booking.id]);
  return toDto(booking, items.get(booking.id) ?? []);
}

/** The owner-only check used before mutating a booking (confirm, cancel, pay). */
export async function assertBookingOwner(viewer: AuthUser, bookingId: string) {
  const row = await db.selectFrom('bookings').select('userId').where('id', '=', bookingId).executeTakeFirst();
  if (!row || (row.userId !== viewer.id && viewer.role !== 'admin')) throw notFound('Booking');
}

export async function listBookingsFor(
  userId: string,
  opts: { status?: BookingDtoType['status']; limit: number; cursor?: { at: Date; id: string } },
) {
  let q = selectBookings().where('b.userId', '=', userId);
  if (opts.status) q = q.where('b.status', '=', opts.status);
  if (opts.cursor) {
    const { at, id } = opts.cursor;
    q = q.where((eb) => eb(eb.refTuple('b.createdAt', 'b.id'), '<', eb.tuple(at, id)));
  }
  const rows = await q
    .orderBy('b.createdAt', 'desc')
    .orderBy('b.id', 'desc')
    .limit(opts.limit + 1)
    .execute();

  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  const items = await itemsFor(page.map((b) => b.id));
  return {
    data: page.map((b) => toDto(b, items.get(b.id) ?? [])),
    last: hasMore ? page.at(-1) : undefined,
  };
}
