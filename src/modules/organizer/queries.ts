import { sql } from 'kysely';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { AppError } from '../../lib/errors.js';
import { acquirableSql } from '../bookings/service.js';

/*
 * The numbers behind the organizer dashboard. Each is one grouped query over indexes that
 * already exist: event_seats by event, bookings_event_idx (event_id, status), the partial
 * bookings_event_confirmed_idx for sales over time, tickets_event_idx for check-ins.
 *
 * Revenue is money actually kept: what was charged, minus what was refunded. Counting
 * payments rather than bookings gets the edge cases right on its own: a duplicate charge
 * that was refunded nets to zero, as does a late payment for seats that were gone.
 */

export interface MoneyStats {
  collectedCents: number;
  refundedCents: number;
  netCents: number;
}

/** Seats per event: capacity, sold (booked) and free to take right now. */
export async function seatStats(eventIds: string[]) {
  if (!eventIds.length) return new Map<string, { total: number; sold: number; available: number }>();
  const rows = await db
    .selectFrom('eventSeats as es')
    .leftJoin('bookings as b', 'b.id', 'es.bookingId')
    .where('es.eventId', 'in', eventIds)
    .groupBy('es.eventId')
    .select([
      'es.eventId',
      sql<number>`count(*)`.as('total'),
      sql<number>`count(*) FILTER (WHERE es.status = 'booked')`.as('sold'),
      // Lapsed holds count as free, as everywhere else.
      sql<number>`count(*) FILTER (WHERE ${acquirableSql})`.as('available'),
    ])
    .execute();
  return new Map(rows.map((r) => [r.eventId, { total: r.total, sold: r.sold, available: r.available }]));
}

/** Money per event: charged (succeeded payments, later refunded or not) minus refunds paid out. */
export async function moneyStats(eventIds: string[]): Promise<Map<string, MoneyStats>> {
  const result = new Map<string, MoneyStats>();
  if (!eventIds.length) return result;
  const [collected, refunded] = await Promise.all([
    db
      .selectFrom('payments as p')
      .innerJoin('bookings as b', 'b.id', 'p.bookingId')
      .where('b.eventId', 'in', eventIds)
      .where('p.status', 'in', ['succeeded', 'refunded'])
      .groupBy('b.eventId')
      .select(['b.eventId', sql<number>`sum(p.amount_cents)::int`.as('cents')])
      .execute(),
    db
      .selectFrom('refunds as r')
      .innerJoin('payments as p', 'p.id', 'r.paymentId')
      .innerJoin('bookings as b', 'b.id', 'p.bookingId')
      .where('b.eventId', 'in', eventIds)
      .where('r.status', '=', 'succeeded')
      .groupBy('b.eventId')
      .select(['b.eventId', sql<number>`sum(r.amount_cents)::int`.as('cents')])
      .execute(),
  ]);
  const refundedBy = new Map(refunded.map((r) => [r.eventId, r.cents]));
  for (const id of eventIds) {
    const collectedCents = collected.find((c) => c.eventId === id)?.cents ?? 0;
    const refundedCents = refundedBy.get(id) ?? 0;
    result.set(id, { collectedCents, refundedCents, netCents: collectedCents - refundedCents });
  }
  return result;
}

/** Valid tickets scanned at the door, per event. */
export async function checkInStats(eventIds: string[]) {
  if (!eventIds.length) return new Map<string, number>();
  const rows = await db
    .selectFrom('tickets')
    .where('eventId', 'in', eventIds)
    .where('status', '=', 'valid')
    .where('checkedInAt', 'is not', null)
    .groupBy('eventId')
    .select(['eventId', sql<number>`count(*)`.as('checkedIn')])
    .execute();
  return new Map(rows.map((r) => [r.eventId, r.checkedIn]));
}

/** Bookings by status for one event. */
export async function bookingCounts(eventId: string) {
  const rows = await db
    .selectFrom('bookings')
    .where('eventId', '=', eventId)
    .groupBy('status')
    .select(['status', sql<number>`count(*)`.as('n')])
    .execute();
  const counts = { pending: 0, confirmed: 0, expired: 0, cancelled: 0, refunded: 0 };
  for (const r of rows) counts[r.status] = r.n;
  return counts;
}

export const SALES_BUCKETS = ['5m', '1h', '1d'] as const;
export type SalesBucket = (typeof SALES_BUCKETS)[number];

/** How far back each bucket size looks, so a chart never has thousands of bars. */
const SALES_WINDOW: Record<SalesBucket, string | null> = { '5m': '24 hours', '1h': '14 days', '1d': null };

/**
 * Tickets sold over time, from confirmed bookings (a refund takes a sale back out). Hours and
 * days follow the venue's clock: "Tuesday" means Tuesday where the show is.
 */
export async function salesOverTime(eventId: string, timeZone: string, bucket: SalesBucket) {
  const at =
    bucket === '5m'
      ? sql<Date>`date_bin('5 minutes', b.confirmed_at, TIMESTAMPTZ '2000-01-01 00:00:00+00')`
      : sql<Date>`date_trunc(${bucket === '1h' ? 'hour' : 'day'}, b.confirmed_at, ${timeZone})`;
  const window = SALES_WINDOW[bucket];
  let query = db
    .selectFrom('bookings as b')
    .innerJoin('bookingItems as bi', 'bi.bookingId', 'b.id')
    .where('b.eventId', '=', eventId)
    .where('b.status', '=', 'confirmed');
  if (window) query = query.where('b.confirmedAt', '>', sql<Date>`now() - ${window}::interval`);
  const rows = await query
    .groupBy(sql`1`)
    .orderBy(sql`1`)
    .select([
      at.as('at'),
      sql<number>`count(*)`.as('tickets'),
      sql<number>`sum(bi.price_cents)::int`.as('revenueCents'),
    ])
    .execute();
  return rows.map((r) => ({ at: r.at.toISOString(), tickets: r.tickets, revenueCents: r.revenueCents }));
}

// ─── attendees ──────────────────────────────────────────────────────────────────────────

/** Keyset cursor over (holder name, ticket id): pages stay fast however deep you go. */
const AttendeeCursor = z.object({ n: z.string(), id: z.uuid() });

export const encodeAttendeeCursor = (name: string, id: string) =>
  Buffer.from(JSON.stringify({ n: name, id })).toString('base64url');

export function decodeAttendeeCursor(raw: string) {
  try {
    return AttendeeCursor.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
  } catch {
    throw new AppError(400, 'INVALID_CURSOR', 'Cursor is malformed');
  }
}

/** One row per valid ticket (a refunded ticket isn't an attendee), ordered by name. */
export function attendeesQuery(
  eventId: string,
  { q, after }: { q?: string; after?: { n: string; id: string } },
) {
  let query = db
    .selectFrom('tickets as t')
    .innerJoin('bookings as b', 'b.id', 't.bookingId')
    .innerJoin('users as u', 'u.id', 'b.userId')
    .innerJoin('eventSeats as es', 'es.id', 't.eventSeatId')
    .innerJoin('venueSeats as vs', 'vs.id', 'es.venueSeatId')
    .innerJoin('venueSections as sec', 'sec.id', 'vs.sectionId')
    .where('t.eventId', '=', eventId)
    .where('t.status', '=', 'valid')
    .select([
      't.id as ticketId',
      't.checkedInAt',
      'b.id as bookingId',
      'b.confirmedAt',
      'u.name',
      'u.email',
      'sec.name as section',
      'vs.rowLabel',
      'vs.seatNumber',
    ]);
  if (q) {
    const pattern = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    query = query.where((eb) => eb.or([eb('u.name', 'ilike', pattern), eb('u.email', 'ilike', pattern)]));
  }
  if (after) query = query.where(sql<boolean>`(u.name, t.id) > (${after.n}, ${after.id}::uuid)`);
  return query.orderBy('u.name').orderBy('t.id');
}
