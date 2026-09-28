import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/types.js';

/**
 * Business invariants that must hold no matter how much concurrency the system has been
 * through. Each check is a query that returns the rows breaking the rule, so a healthy
 * database returns nothing.
 *
 * Run after load tests (npm run check:invariants) and in the test suite. This is how "no
 * seat was sold twice" gets verified, rather than assumed.
 */
const CHECKS: Array<{ name: string; description: string; query: ReturnType<typeof sql> }> = [
  {
    name: 'seat_sold_twice',
    description: 'A seat belongs to more than one active (pending or confirmed) booking',
    query: sql`
      SELECT bi.event_seat_id AS id, count(*) AS bookings
      FROM booking_items bi JOIN bookings b ON b.id = bi.booking_id
      WHERE b.status IN ('pending', 'confirmed')
      GROUP BY bi.event_seat_id HAVING count(*) > 1`,
  },
  {
    name: 'taken_seat_without_holder',
    description: 'A held/booked seat points at a booking that does not contain it',
    query: sql`
      SELECT es.id FROM event_seats es
      LEFT JOIN booking_items bi ON bi.booking_id = es.booking_id AND bi.event_seat_id = es.id
      WHERE es.status <> 'available' AND bi.booking_id IS NULL`,
  },
  {
    name: 'booked_seat_unconfirmed',
    description: 'A seat is marked booked but its booking is not confirmed',
    query: sql`
      SELECT es.id FROM event_seats es JOIN bookings b ON b.id = es.booking_id
      WHERE es.status = 'booked' AND b.status <> 'confirmed'`,
  },
  {
    name: 'confirmed_booking_missing_seat',
    description: 'A confirmed booking has a seat that is not booked by it',
    query: sql`
      SELECT bi.booking_id, bi.event_seat_id FROM booking_items bi
      JOIN bookings b ON b.id = bi.booking_id
      JOIN event_seats es ON es.id = bi.event_seat_id
      WHERE b.status = 'confirmed' AND (es.status <> 'booked' OR es.booking_id IS DISTINCT FROM b.id)`,
  },
  {
    name: 'valid_ticket_without_sale',
    description: 'A valid ticket belongs to a booking that is not confirmed',
    query: sql`
      SELECT t.id FROM tickets t JOIN bookings b ON b.id = t.booking_id
      WHERE t.status = 'valid' AND b.status <> 'confirmed'`,
  },
  {
    name: 'confirmed_without_tickets',
    description: 'A confirmed booking does not have exactly one valid ticket per seat',
    query: sql`
      SELECT b.id FROM bookings b
      WHERE b.status = 'confirmed'
        AND (SELECT count(*) FROM booking_items bi WHERE bi.booking_id = b.id)
         <> (SELECT count(*) FROM tickets t WHERE t.booking_id = b.id AND t.status = 'valid')`,
  },
  {
    name: 'paid_but_nothing_delivered',
    description: 'A payment succeeded, its booking is not confirmed, and no refund was issued',
    query: sql`
      SELECT p.id FROM payments p JOIN bookings b ON b.id = p.booking_id
      WHERE p.status = 'succeeded' AND b.status <> 'confirmed'
        AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.payment_id = p.id AND r.status <> 'failed')`,
  },
  {
    name: 'charged_twice',
    description: 'A booking has more than one kept (succeeded, unrefunded) payment',
    query: sql`
      SELECT p.booking_id FROM payments p
      WHERE p.status = 'succeeded'
        AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.payment_id = p.id AND r.status <> 'failed')
      GROUP BY p.booking_id HAVING count(*) > 1`,
  },
  {
    name: 'refunded_booking_still_holding',
    description: 'A refunded booking still holds seats or valid tickets',
    query: sql`
      SELECT b.id FROM bookings b
      WHERE b.status = 'refunded'
        AND (EXISTS (SELECT 1 FROM event_seats es WHERE es.booking_id = b.id)
          OR EXISTS (SELECT 1 FROM tickets t WHERE t.booking_id = b.id AND t.status = 'valid'))`,
  },
];

export interface Violation {
  name: string;
  description: string;
  count: number;
  sample: unknown[];
}

export async function checkInvariants(db: Kysely<DB>): Promise<Violation[]> {
  const violations: Violation[] = [];
  for (const check of CHECKS) {
    const { rows } = await check.query.execute(db);
    if (rows.length) {
      violations.push({
        name: check.name,
        description: check.description,
        count: rows.length,
        sample: rows.slice(0, 5),
      });
    }
  }
  return violations;
}

export const INVARIANT_NAMES = CHECKS.map((c) => c.name);
