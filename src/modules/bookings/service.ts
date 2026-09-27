import { sql, type Kysely, type Transaction } from 'kysely';
import { db } from '../../db/index.js';
import { withTransaction } from '../../db/transaction.js';
import type { Booking, DB, EventStatus, SeatStatus } from '../../db/types.js';
import { AppError, conflict, notFound, unprocessable } from '../../lib/errors.js';
import { holdAttempts } from '../../lib/metrics.js';
import { enqueue } from '../../jobs/outbox.js';
import { issueTickets, voidTickets } from '../tickets/service.js';
import { claimSeats } from './claims.js';

/*
 * ─── How double booking is prevented ────────────────────────────────────────────────────
 *
 * Seat rows in event_seats are the single source of truth. A seat is taken by pointing
 * event_seats.booking_id at a booking and setting status to 'held' (pending payment) or
 * 'booked' (paid). The question is how to make "check the seat is free, then take it" safe
 * when hundreds of requests do it at the same instant. Four strategies are implemented so
 * they can be compared (scripts/race-test.ts fires 200 concurrent requests at one seat):
 *
 *  naive         Read, check, write, with no locking. Two requests can both read "available"
 *                before either writes: a race condition, and both get the seat. Kept only to
 *                demonstrate the bug.
 *
 *  pessimistic   SELECT ... FOR UPDATE SKIP LOCKED. The first transaction locks the seat
 *  (default)     rows. Everyone else skips the locked rows, sees fewer seats than requested,
 *                and fails immediately with 409 instead of queueing behind the lock.
 *                Failing fast keeps connections free during a rush.
 *
 *  optimistic    No locks while reading. The write is conditional:
 *                UPDATE ... WHERE version = <version I read>. If anyone changed the seat in
 *                between, zero rows match, and we roll back and report a conflict.
 *
 *  serializable  Plain reads and writes in a SERIALIZABLE transaction. Postgres detects
 *                that concurrent transactions couldn't have run one after another, aborts
 *                all but one with 40001, and the retries then see the seat taken.
 *
 * Holds expire lazily: a seat held by a booking whose expires_at has passed counts as free
 * ("acquirable"). Correctness never waits for a background job; the expiry worker only
 * tidies up and tells live clients.
 *
 * Lock order everywhere: seat rows (ascending id), then booking rows. One global order
 * means no lock cycles, so these operations can't deadlock one another.
 */

export const HOLD_STRATEGIES = ['pessimistic', 'optimistic', 'serializable', 'naive'] as const;
export type HoldStrategy = (typeof HOLD_STRATEGIES)[number];

export interface BookingOptions {
  strategy: HoldStrategy;
  claimGate: boolean;
  holdTtlSeconds: number;
}

type Conn = Kysely<DB> | Transaction<DB>;

/** A seat change, reported so it can be broadcast to live seat maps. */
export interface SeatChange {
  id: number;
  status: SeatStatus;
  version: number;
}

// ─── shared queries ──────────────────────────────────────────────────────────────────────

/**
 * True when a seat can be taken right now: free, or held by a booking that is no longer
 * an active hold (lapsed, cancelled, expired). Evaluated in SQL with the database clock,
 * so every API instance agrees on what "expired" means.
 */
export const acquirableSql = sql<boolean>`(es.status = 'available' OR (es.status = 'held' AND (b.status <> 'pending' OR b.expires_at <= now())))`;

function seatQuery(conn: Conn, seatIds: number[]) {
  return conn
    .selectFrom('eventSeats as es')
    .leftJoin('bookings as b', 'b.id', 'es.bookingId')
    .select([
      'es.id',
      'es.eventId',
      'es.status',
      'es.bookingId',
      'es.priceCents',
      'es.version',
      acquirableSql.as('acquirable'),
    ])
    .where('es.id', 'in', seatIds)
    .orderBy('es.id');
}

type SeatRow = Awaited<ReturnType<ReturnType<typeof seatQuery>['execute']>>[number];

async function assertSeatsExist(conn: Conn, eventId: string, seatIds: number[], found: SeatRow[]) {
  const existing = new Set(
    found.length === seatIds.length
      ? found.map((r) => r.id)
      : (
          await conn
            .selectFrom('eventSeats')
            .select('id')
            .where('eventId', '=', eventId)
            .where('id', 'in', seatIds)
            .execute()
        ).map((r) => r.id),
  );
  const unknown = seatIds.filter((id) => !existing.has(id));
  if (unknown.length)
    throw unprocessable('UNKNOWN_SEATS', 'Some seats do not exist for this event', { seatIds: unknown });
}

function assertAcquirable(rows: SeatRow[]) {
  const taken = rows.filter((r) => !r.acquirable).map((r) => r.id);
  if (taken.length)
    throw conflict('SEATS_UNAVAILABLE', 'Some seats are no longer available', { seatIds: taken });
}

/** Release every seat still pointing at this booking. Idempotent. */
async function releaseSeats(trx: Transaction<DB>, bookingId: string): Promise<SeatChange[]> {
  return trx
    .updateTable('eventSeats')
    .set({ status: 'available', bookingId: null, version: sql`version + 1` })
    .where('bookingId', '=', bookingId)
    .returning(['id', 'status', 'version'])
    .execute();
}

// ─── placing a hold ──────────────────────────────────────────────────────────────────────

export interface HoldRequest {
  userId: string;
  eventId: string;
  seatIds: number[];
}

interface SaleableEvent {
  id: string;
  currency: string;
  maxTicketsPerUser: number;
}

async function loadSaleableEvent(eventId: string, seatCount: number): Promise<SaleableEvent> {
  const event = await db
    .selectFrom('events')
    .select(['id', 'status', 'startsAt', 'salesStartAt', 'maxTicketsPerUser', 'currency'])
    .where('id', '=', eventId)
    .executeTakeFirst();
  if (!event || event.status === 'draft') throw notFound('Event');
  if (event.status === 'cancelled') throw conflict('EVENT_CANCELLED', 'This event has been cancelled');

  const now = new Date();
  if (event.startsAt <= now) throw conflict('SALES_CLOSED', 'Sales have closed for this event');
  if (event.salesStartAt && event.salesStartAt > now) {
    throw conflict('SALES_NOT_STARTED', 'Tickets are not on sale yet', {
      salesStartAt: event.salesStartAt.toISOString(),
    });
  }
  if (seatCount > event.maxTicketsPerUser) {
    throw unprocessable('TOO_MANY_SEATS', `At most ${event.maxTicketsPerUser} tickets per customer`);
  }
  return { id: event.id, currency: event.currency.trim(), maxTicketsPerUser: event.maxTicketsPerUser };
}

/**
 * The per-user checks that run before the seat transaction:
 *  - a lapsed hold of this user is expired first (its expiry may not have been processed
 *    yet), so it doesn't trip the one-active-hold-per-user index;
 *  - an active hold is reported with its id, so the client can resume it;
 *  - the ticket limit counts seats in this user's confirmed bookings.
 */
async function checkUserLimits(req: HoldRequest, event: SaleableEvent) {
  const pending = await db
    .selectFrom('bookings')
    .select(['id', sql<boolean>`expires_at <= now()`.as('lapsed')])
    .where('userId', '=', req.userId)
    .where('eventId', '=', req.eventId)
    .where('status', '=', 'pending')
    .executeTakeFirst();
  if (pending?.lapsed) await expireBooking(pending.id);
  else if (pending) {
    throw conflict(
      'HOLD_EXISTS',
      'You already have seats on hold for this event; pay for or cancel them first',
      {
        bookingId: pending.id,
      },
    );
  }

  const { owned } = await db
    .selectFrom('bookingItems as bi')
    .innerJoin('bookings as b', 'b.id', 'bi.bookingId')
    .select((eb) => eb.fn.countAll<number>().as('owned'))
    .where('b.userId', '=', req.userId)
    .where('b.eventId', '=', req.eventId)
    .where('b.status', '=', 'confirmed')
    .executeTakeFirstOrThrow();
  if (owned + req.seatIds.length > event.maxTicketsPerUser) {
    throw conflict('TICKET_LIMIT_EXCEEDED', `At most ${event.maxTicketsPerUser} tickets per customer`, {
      alreadyOwned: owned,
    });
  }
}

/** Insert the booking and its items, and take the seats. Runs inside the strategy's transaction. */
async function createHold(
  trx: Transaction<DB>,
  req: HoldRequest,
  event: SaleableEvent,
  rows: SeatRow[],
  opts: BookingOptions,
  seatWrite: 'plain' | 'versioned',
): Promise<{ bookingId: string; changes: SeatChange[] }> {
  const booking = await trx
    .insertInto('bookings')
    .values({
      userId: req.userId,
      eventId: req.eventId,
      totalCents: rows.reduce((sum, r) => sum + r.priceCents, 0),
      currency: event.currency,
      expiresAt: sql<Date>`now() + make_interval(secs => ${opts.holdTtlSeconds})`,
    })
    .returning(['id', 'expiresAt'])
    .executeTakeFirstOrThrow();

  // Release the seats the moment the hold lapses (a second later, so the hold has definitely
  // lapsed by the database's clock). Part of this transaction, via the outbox.
  await enqueue(
    trx,
    'bookings',
    'expire-booking',
    { bookingId: booking.id },
    { jobId: `expire-booking_${booking.id}`, runAt: new Date(booking.expiresAt.getTime() + 1_000) },
  );

  let changes: SeatChange[];
  if (seatWrite === 'versioned') {
    // Only update a seat whose version is still the one we read. Any concurrent change bumps
    // the version, so the row no longer matches.
    changes = await sql<SeatChange>`
      UPDATE event_seats es
      SET status = 'held', booking_id = ${booking.id}, version = es.version + 1
      FROM unnest(${rows.map((r) => r.id)}::bigint[], ${rows.map((r) => r.version)}::int[]) AS seen(id, version)
      WHERE es.id = seen.id AND es.version = seen.version
      RETURNING es.id, es.status, es.version
    `
      .execute(trx)
      .then((r) => r.rows);
    if (changes.length !== rows.length) {
      throw conflict('SEATS_UNAVAILABLE', 'Some seats were taken while you were booking', {
        seatIds: rows.filter((r) => !changes.some((c) => c.id === r.id)).map((r) => r.id),
      });
    }
  } else {
    changes = await trx
      .updateTable('eventSeats')
      .set({ status: 'held', bookingId: booking.id, version: sql`version + 1` })
      .where('id', 'in', req.seatIds)
      .returning(['id', 'status', 'version'])
      .execute();
  }

  await trx
    .insertInto('bookingItems')
    .values(rows.map((r) => ({ bookingId: booking.id, eventSeatId: r.id, priceCents: r.priceCents })))
    .execute();

  // Seats taken over from lapsed holds: mark those bookings expired now rather than leave
  // them looking active. (Seats first, then bookings: the global lock order.)
  const lapsed = [
    ...new Set(rows.filter((r) => r.status === 'held' && r.bookingId).map((r) => r.bookingId!)),
  ];
  if (lapsed.length) {
    await trx
      .updateTable('bookings')
      .set({ status: 'expired', expiredAt: sql`now()` })
      .where('id', 'in', lapsed)
      .where('status', '=', 'pending')
      .where('expiresAt', '<=', sql<Date>`now()`)
      .execute();
  }

  return { bookingId: booking.id, changes };
}

const strategies: Record<
  HoldStrategy,
  (
    req: HoldRequest,
    event: SaleableEvent,
    opts: BookingOptions,
  ) => Promise<{ bookingId: string; changes: SeatChange[] }>
> = {
  async pessimistic(req, event, opts) {
    return withTransaction(async (trx) => {
      // Lock the requested seats in id order. SKIP LOCKED: seats another transaction is
      // working on right now are left out instead of waited for.
      const rows = await seatQuery(trx, req.seatIds)
        .where('es.eventId', '=', req.eventId)
        .forUpdate('es')
        .skipLocked()
        .execute();
      if (rows.length < req.seatIds.length) {
        await assertSeatsExist(trx, req.eventId, req.seatIds, rows);
        throw conflict('SEATS_UNAVAILABLE', 'Some seats are being booked by someone else right now', {
          seatIds: req.seatIds.filter((id) => !rows.some((r) => r.id === id)),
        });
      }
      assertAcquirable(rows);
      return createHold(trx, req, event, rows, opts, 'plain');
    });
  },

  async optimistic(req, event, opts) {
    // Read without locks; the versioned write inside the transaction detects interference.
    const rows = await seatQuery(db, req.seatIds).where('es.eventId', '=', req.eventId).execute();
    await assertSeatsExist(db, req.eventId, req.seatIds, rows);
    assertAcquirable(rows);
    return withTransaction((trx) => createHold(trx, req, event, rows, opts, 'versioned'));
  },

  async serializable(req, event, opts) {
    // Plain reads and writes. SERIALIZABLE makes Postgres abort (40001) whichever
    // transactions couldn't have run one after another; withTransaction retries them,
    // and on retry they see the seat taken.
    return withTransaction(
      async (trx) => {
        const rows = await seatQuery(trx, req.seatIds).where('es.eventId', '=', req.eventId).execute();
        await assertSeatsExist(trx, req.eventId, req.seatIds, rows);
        assertAcquirable(rows);
        return createHold(trx, req, event, rows, opts, 'plain');
      },
      { isolation: 'serializable', retries: 5 },
    );
  },

  async naive(req, event, opts) {
    // BROKEN ON PURPOSE: between this read and the write below, other requests can read
    // the same "available" seats, and every one of them will write.
    const rows = await seatQuery(db, req.seatIds).where('es.eventId', '=', req.eventId).execute();
    await assertSeatsExist(db, req.eventId, req.seatIds, rows);
    assertAcquirable(rows);
    return db.transaction().execute((trx) => createHold(trx, req, event, rows, opts, 'plain'));
  },
};

function isOnePendingViolation(err: unknown) {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && e.constraint === 'bookings_one_pending_per_user_event';
}

/** Place a hold: validate, pass the claim gate, then run the configured strategy. */
export async function holdSeats(
  req: HoldRequest,
  opts: BookingOptions,
): Promise<{ bookingId: string; changes: SeatChange[] }> {
  const seatIds = [...new Set(req.seatIds)].sort((a, b) => a - b);
  const request = { ...req, seatIds };
  const event = await loadSaleableEvent(req.eventId, seatIds.length);
  await checkUserLimits(request, event);

  const claim = opts.claimGate ? await claimSeats(req.eventId, seatIds) : null;
  if (claim && !claim.ok) {
    holdAttempts.inc({ strategy: opts.strategy, outcome: 'gate_rejected' });
    throw conflict('SEATS_UNAVAILABLE', 'Some seats are being booked by someone else right now', {
      seatIds: [claim.conflictingSeatId],
    });
  }

  try {
    const result = await strategies[opts.strategy](request, event, opts);
    holdAttempts.inc({ strategy: opts.strategy, outcome: 'success' });
    return result;
  } catch (err) {
    const isConflict = err instanceof AppError && err.statusCode === 409;
    holdAttempts.inc({
      strategy: opts.strategy,
      outcome: isConflict || isOnePendingViolation(err) ? 'db_conflict' : 'error',
    });
    // Two concurrent holds by the same user: the partial unique index lets only one commit.
    if (isOnePendingViolation(err)) {
      throw conflict(
        'HOLD_EXISTS',
        'You already have seats on hold for this event; pay for or cancel them first',
      );
    }
    throw err;
  } finally {
    await claim?.release();
  }
}

// ─── lifecycle transitions ───────────────────────────────────────────────────────────────

/**
 * Lock a booking's seats (ascending id) and then the booking itself: the global lock order.
 * Returns the seats (with acquirability) and the booking.
 */
export async function lockBooking(trx: Transaction<DB>, bookingId: string) {
  const items = await trx
    .selectFrom('bookingItems')
    .select('eventSeatId')
    .where('bookingId', '=', bookingId)
    .orderBy('eventSeatId')
    .execute();
  const seatIds = items.map((i) => i.eventSeatId);
  const seats = seatIds.length ? await seatQuery(trx, seatIds).forUpdate('es').execute() : [];
  const booking = await trx
    .selectFrom('bookings')
    .selectAll()
    // Judged by the database clock, so every API instance agrees on when a hold lapses.
    .select(sql<boolean>`expires_at <= now()`.as('lapsed'))
    .where('id', '=', bookingId)
    .forUpdate()
    .executeTakeFirst();
  return { seats, booking, seatIds };
}

/** Expire a lapsed hold and release its seats. Safe to call repeatedly and concurrently. */
export async function expireBooking(bookingId: string): Promise<SeatChange[]> {
  return withTransaction(async (trx) => {
    const { booking } = await lockBooking(trx, bookingId);
    if (!booking) return [];
    if (booking.status === 'pending') {
      if (!booking.lapsed) return []; // still valid (e.g. the job ran early)
      await trx
        .updateTable('bookings')
        .set({ status: 'expired', expiredAt: sql`now()` })
        .where('id', '=', bookingId)
        .execute();
      return releaseSeats(trx, bookingId);
    }
    // Already expired/cancelled (e.g. marked lapsed by a competing hold): release any seats
    // still pointing at it. Confirmed and refunded bookings are left alone.
    if (booking.status === 'expired' || booking.status === 'cancelled') return releaseSeats(trx, bookingId);
    return [];
  });
}

export type ConfirmOutcome =
  | { kind: 'confirmed'; changes: SeatChange[]; late: boolean }
  | { kind: 'already_confirmed' }
  | { kind: 'hold_expired' }
  | { kind: 'seats_lost' }
  | { kind: 'event_unavailable'; eventStatus: EventStatus }
  | { kind: 'not_confirmable'; status: Booking['status'] };

/**
 * Turn a hold into a sale, inside the caller's transaction (the payment flow also records
 * the payment in the same transaction). `lateAllowed` is for payments: money has already
 * moved, so if the hold lapsed but the seats are still free, take them back rather than refund.
 */
export async function confirmBookingInTx(
  trx: Transaction<DB>,
  bookingId: string,
  { lateAllowed = false } = {},
): Promise<ConfirmOutcome> {
  const { seats, booking, seatIds } = await lockBooking(trx, bookingId);
  if (!booking) throw notFound('Booking');
  if (booking.status === 'confirmed') return { kind: 'already_confirmed' };

  const event = await trx
    .selectFrom('events')
    .select(['status', 'startsAt'])
    .where('id', '=', booking.eventId)
    .executeTakeFirstOrThrow();
  if (event.status !== 'published' || event.startsAt <= new Date())
    return { kind: 'event_unavailable', eventStatus: event.status };

  const stillOurs = seats.every((s) => s.bookingId === bookingId && s.status === 'held');
  const lapsed = booking.lapsed;

  let late: boolean;
  if (booking.status === 'pending' && stillOurs) {
    if (lapsed && !lateAllowed) {
      await trx
        .updateTable('bookings')
        .set({ status: 'expired', expiredAt: sql`now()` })
        .where('id', '=', bookingId)
        .execute();
      await releaseSeats(trx, bookingId);
      return { kind: 'hold_expired' };
    }
    late = lapsed;
  } else if (booking.status === 'pending' || booking.status === 'expired' || booking.status === 'cancelled') {
    // The hold is gone. Only a payment may try to win the seats back.
    if (!lateAllowed)
      return booking.status === 'cancelled'
        ? { kind: 'not_confirmable', status: booking.status }
        : { kind: 'hold_expired' };
    if (!seats.every((s) => s.bookingId === bookingId || s.acquirable)) return { kind: 'seats_lost' };
    // Seats now pointing at other lapsed holds: those holds are over.
    const lapsedHolders = [
      ...new Set(seats.map((s) => s.bookingId).filter((id): id is string => !!id && id !== bookingId)),
    ];
    if (lapsedHolders.length) {
      await trx
        .updateTable('bookings')
        .set({ status: 'expired', expiredAt: sql`now()` })
        .where('id', 'in', lapsedHolders)
        .where('status', '=', 'pending')
        .execute();
    }
    late = true;
  } else {
    return { kind: 'not_confirmable', status: booking.status };
  }

  const changes = await trx
    .updateTable('eventSeats')
    .set({ status: 'booked', bookingId, version: sql`version + 1` })
    .where('id', 'in', seatIds)
    .returning(['id', 'status', 'version'])
    .execute();
  await trx
    .updateTable('bookings')
    .set({ status: 'confirmed', confirmedAt: sql`now()` })
    .where('id', '=', bookingId)
    .execute();

  // Same transaction: tickets exist exactly when the booking is confirmed, and the email
  // with the QR codes is queued only if all of this commits.
  await issueTickets(trx, bookingId);
  await enqueue(
    trx,
    'email',
    'booking-confirmed',
    { bookingId },
    { jobId: `booking-confirmed_${bookingId}` },
  );
  return { kind: 'confirmed', changes, late };
}

export function confirmBooking(
  bookingId: string,
  opts: { lateAllowed?: boolean } = {},
): Promise<ConfirmOutcome> {
  return withTransaction((trx) => confirmBookingInTx(trx, bookingId, opts));
}

/**
 * End a confirmed booking: its seats go back on sale and its tickets stop working. Used when
 * a refund completes ('refunded') and for unpaid (free) bookings of a cancelled event
 * ('cancelled'). Runs in the caller's transaction, locking seats then the booking.
 */
export async function endConfirmedBookingInTx(
  trx: Transaction<DB>,
  bookingId: string,
  to: 'refunded' | 'cancelled',
): Promise<SeatChange[]> {
  const { booking } = await lockBooking(trx, bookingId);
  if (!booking || booking.status !== 'confirmed') return [];
  await trx
    .updateTable('bookings')
    .set(
      to === 'refunded'
        ? { status: 'refunded', refundedAt: sql`now()` }
        : { status: 'cancelled', cancelledAt: sql`now()` },
    )
    .where('id', '=', bookingId)
    .execute();
  await voidTickets(trx, bookingId);
  return releaseSeats(trx, bookingId);
}

/** Cancel a pending booking (the buyer walks away) and release its seats. */
export async function cancelPendingBooking(bookingId: string): Promise<SeatChange[]> {
  return withTransaction(async (trx) => {
    const { booking } = await lockBooking(trx, bookingId);
    if (!booking) throw notFound('Booking');
    if (booking.status !== 'pending') {
      throw conflict(
        'BOOKING_NOT_PENDING',
        `Only pending bookings can be cancelled this way (status is ${booking.status})`,
      );
    }
    await trx
      .updateTable('bookings')
      .set({ status: 'cancelled', cancelledAt: sql`now()` })
      .where('id', '=', bookingId)
      .execute();
    return releaseSeats(trx, bookingId);
  });
}

/**
 * When an event is cancelled, void every hold on it. Runs inside the event-cancel
 * transaction, which already holds the event row lock. Seats are locked before bookings,
 * as everywhere else.
 */
export async function cancelPendingBookingsForEvent(
  trx: Transaction<DB>,
  eventId: string,
): Promise<SeatChange[]> {
  await trx
    .selectFrom('eventSeats')
    .select('id')
    .where('eventId', '=', eventId)
    .where('status', '=', 'held')
    .orderBy('id')
    .forUpdate()
    .execute();
  const cancelled = await trx
    .updateTable('bookings')
    .set({ status: 'cancelled', cancelledAt: sql`now()` })
    .where('eventId', '=', eventId)
    .where('status', '=', 'pending')
    .returning('id')
    .execute();
  if (!cancelled.length) return [];
  return trx
    .updateTable('eventSeats')
    .set({ status: 'available', bookingId: null, version: sql`version + 1` })
    .where('eventId', '=', eventId)
    .where('status', '=', 'held')
    .returning(['id', 'status', 'version'])
    .execute();
}
