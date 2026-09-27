import { sql, type Transaction } from 'kysely';
import { UnrecoverableError } from 'bullmq';
import { config } from '../../config.js';
import { db } from '../../db/index.js';
import { withTransaction } from '../../db/transaction.js';
import type { DB, Payment, RefundReason } from '../../db/types.js';
import { enqueue } from '../../jobs/outbox.js';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import type { AuthUser } from '../auth/guard.js';
import {
  confirmBookingInTx,
  endConfirmedBookingInTx,
  lockBooking,
  type SeatChange,
} from '../bookings/service.js';
import { getPaymentProvider } from './providers/index.js';
import { WebhookSignatureError } from './signature.js';

/*
 * ─── How money moves ─────────────────────────────────────────────────────────────────────
 *
 *  1. POST /bookings/:id/payment     → payment row + provider payment intent (client secret)
 *  2. the browser pays at the provider (Stripe.js / the fake gateway's confirm endpoint)
 *  3. the provider POSTs a signed webhook → stored once (dedupe by event id) → job queued
 *  4. the job RECONCILES: it asks the provider for the payment's *current* state and acts
 *     on that. The event's own contents are only a hint.
 *
 * Why re-fetch instead of trusting the event? Webhooks arrive at least once and in any
 * order: "succeeded" can come before "processing", or twice. Reading the current state makes
 * every processing run converge on the same answer, however many times and in whatever
 * order the events arrive.
 *
 * Reconciling a success confirms the booking in the SAME transaction that records the
 * payment. If that's no longer possible (the hold lapsed and someone took the seats, the
 * event was cancelled, or the booking was already paid) the money goes back: a refund is
 * created in that same transaction.
 *
 * Lock order continues the global one: seats → booking → payment.
 */

export interface PaymentView {
  id: string;
  provider: string;
  providerPaymentId: string | null;
  clientSecret: string | null;
  amountCents: number;
  currency: string;
  status: Payment['status'];
  lastError: string | null;
}

const view = (p: Payment): PaymentView => ({
  id: p.id,
  provider: p.provider,
  providerPaymentId: p.providerPaymentId,
  clientSecret: p.clientSecret,
  amountCents: p.amountCents,
  currency: p.currency.trim(),
  status: p.status,
  lastError: p.lastError,
});

// ─── starting a payment ──────────────────────────────────────────────────────────────────

/**
 * Create (or return the existing) payment for a pending booking. Naturally idempotent: while
 * a payment is open for the booking, every call returns that same payment.
 */
export async function startPayment(
  user: AuthUser,
  bookingId: string,
): Promise<{ payment: PaymentView; created: boolean }> {
  const provider = getPaymentProvider();
  const { payment, created } = await withTransaction(async (trx) => {
    const booking = await trx
      .selectFrom('bookings')
      .select([
        'id',
        'userId',
        'status',
        'totalCents',
        'currency',
        sql<boolean>`expires_at <= now()`.as('lapsed'),
      ])
      .where('id', '=', bookingId)
      .forUpdate()
      .executeTakeFirst();
    if (!booking || (booking.userId !== user.id && user.role !== 'admin')) throw notFound('Booking');
    if (booking.status !== 'pending') {
      throw conflict(
        'BOOKING_NOT_PENDING',
        `Only pending bookings can be paid (status is ${booking.status})`,
      );
    }
    if (booking.lapsed) throw conflict('HOLD_EXPIRED', 'The seat hold has expired; please book again');

    const open = await trx
      .selectFrom('payments')
      .selectAll()
      .where('bookingId', '=', bookingId)
      .where('status', 'in', ['requires_payment', 'processing'])
      .executeTakeFirst();
    if (open) return { payment: open, created: false };

    const inserted = await trx
      .insertInto('payments')
      .values({
        bookingId,
        provider: provider.name,
        amountCents: booking.totalCents,
        currency: booking.currency,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { payment: inserted, created: true };
  });

  if (payment.providerPaymentId && payment.clientSecret) return { payment: view(payment), created };

  // The provider call happens outside any transaction (never hold row locks across a network
  // call). Its idempotency key is our payment id: if we crash after the provider created the
  // intent but before we saved it, the retry gets the same intent, not a second one.
  const intent = await provider.createPayment(
    {
      amountCents: payment.amountCents,
      currency: payment.currency.trim(),
      description: `Booking ${bookingId}`,
      metadata: { bookingId, paymentId: payment.id },
    },
    `payment-${payment.id}`,
  );
  const saved = await db
    .updateTable('payments')
    .set({ providerPaymentId: intent.id, clientSecret: intent.clientSecret })
    .where('id', '=', payment.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  return { payment: view(saved), created };
}

// ─── webhooks ────────────────────────────────────────────────────────────────────────────

/**
 * Verify, store once, queue processing, and answer fast. Providers expect a quick 2xx and
 * retry otherwise, so the actual work happens in a job.
 */
export async function ingestWebhook(
  providerName: string,
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
): Promise<{ duplicate: boolean }> {
  const provider = getPaymentProvider();
  if (provider.name !== providerName) throw notFound('Webhook endpoint');

  let event;
  try {
    event = provider.parseWebhook(rawBody, headers);
  } catch (err) {
    if (err instanceof WebhookSignatureError) throw new AppError(400, 'INVALID_SIGNATURE', err.message);
    throw new AppError(400, 'INVALID_PAYLOAD', 'Unreadable webhook payload');
  }

  const stored = await db.transaction().execute(async (trx) => {
    const row = await trx
      .insertInto('webhookEvents')
      .values({
        provider: providerName,
        eventId: event.id,
        type: event.type,
        providerPaymentId: event.providerPaymentId,
        payload: rawBody.toString('utf8'),
      })
      .onConflict((oc) => oc.columns(['provider', 'eventId']).doNothing())
      .returning('eventId')
      .executeTakeFirst();
    if (row && event.providerPaymentId) {
      await enqueue(
        trx,
        'payments',
        'process-webhook',
        { provider: providerName, eventId: event.id },
        { jobId: `webhook_${providerName}_${event.id}` },
      );
    }
    return !!row;
  });
  return { duplicate: !stored };
}

export async function processWebhookEvent(providerName: string, eventId: string) {
  const event = await db
    .selectFrom('webhookEvents')
    .selectAll()
    .where('provider', '=', providerName)
    .where('eventId', '=', eventId)
    .executeTakeFirst();
  if (!event || event.processedAt) return { outcome: 'already_processed' };

  const result = event.providerPaymentId
    ? await reconcilePayment(providerName, event.providerPaymentId)
    : { outcome: 'ignored' };
  await db
    .updateTable('webhookEvents')
    .set({ processedAt: new Date() })
    .where('provider', '=', providerName)
    .where('eventId', '=', eventId)
    .execute();
  return result;
}

// ─── reconciliation ──────────────────────────────────────────────────────────────────────

export interface ReconcileResult {
  outcome: string;
  changes?: SeatChange[];
}

/** Bring our payment (and its booking) in line with the provider's current state. */
export async function reconcilePayment(
  providerName: string,
  providerPaymentId: string,
): Promise<ReconcileResult> {
  const provider = getPaymentProvider();
  if (provider.name !== providerName) return { outcome: 'provider_mismatch' };
  const remote = await provider.retrievePayment(providerPaymentId);

  let payment = await db
    .selectFrom('payments')
    .selectAll()
    .where('provider', '=', providerName)
    .where('providerPaymentId', '=', providerPaymentId)
    .executeTakeFirst();
  if (!payment && remote.metadata.paymentId) {
    // The intent exists at the provider, but we crashed before saving its id: adopt it.
    payment = await db
      .updateTable('payments')
      .set({ providerPaymentId })
      .where('id', '=', remote.metadata.paymentId)
      .where('providerPaymentId', 'is', null)
      .returningAll()
      .executeTakeFirst();
  }
  if (!payment) {
    logger.warn({ providerPaymentId }, 'webhook for a payment we do not know; ignored');
    return { outcome: 'unknown_payment' };
  }

  if (remote.status === 'succeeded' && remote.refundedCents >= remote.amountCents)
    return completeRefund(payment.id);

  switch (remote.status) {
    case 'succeeded':
      return recordSuccess(payment.id);
    case 'processing':
      await db
        .updateTable('payments')
        .set({ status: 'processing' })
        .where('id', '=', payment.id)
        .where('status', '=', 'requires_payment')
        .execute();
      return { outcome: 'processing' };
    case 'canceled':
      await db
        .updateTable('payments')
        .set({ status: 'canceled' })
        .where('id', '=', payment.id)
        .where('status', 'in', ['requires_payment', 'processing'])
        .execute();
      return { outcome: 'canceled' };
    case 'requires_payment':
      // e.g. card declined: the buyer can try again with the same payment.
      await db
        .updateTable('payments')
        .set({ status: 'requires_payment', lastError: remote.lastError })
        .where('id', '=', payment.id)
        .where('status', 'in', ['requires_payment', 'processing'])
        .execute();
      return { outcome: remote.lastError ? 'declined' : 'requires_payment' };
  }
}

class AlreadyRecorded extends Error {}

/**
 * The payment succeeded at the provider. Confirm the booking and record the payment in one
 * transaction, or, if the booking can't be fulfilled any more, record it and refund it.
 */
async function recordSuccess(paymentId: string): Promise<ReconcileResult> {
  const before = await db
    .selectFrom('payments')
    .select(['status', 'bookingId'])
    .where('id', '=', paymentId)
    .executeTakeFirstOrThrow();
  if (before.status === 'succeeded' || before.status === 'refunded') return { outcome: 'already_recorded' };

  try {
    return await withTransaction(async (trx) => {
      // Seats → booking (inside confirmBookingInTx) → payment: the global lock order.
      const outcome = await confirmBookingInTx(trx, before.bookingId, { lateAllowed: true });
      const payment = await trx
        .selectFrom('payments')
        .selectAll()
        .where('id', '=', paymentId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      // A concurrent run recorded it first: roll back whatever this run did.
      if (payment.status === 'succeeded' || payment.status === 'refunded') throw new AlreadyRecorded();

      await trx
        .updateTable('payments')
        .set({ status: 'succeeded', succeededAt: sql`now()`, lastError: null })
        .where('id', '=', paymentId)
        .execute();

      switch (outcome.kind) {
        case 'confirmed':
          return { outcome: outcome.late ? 'confirmed_late' : 'confirmed', changes: outcome.changes };
        case 'already_confirmed':
          // The booking was already paid for (another payment). Don't keep the money twice.
          await createRefund(trx, payment, 'duplicate_payment');
          return { outcome: 'refunding_duplicate' };
        case 'event_unavailable':
          await createRefund(
            trx,
            payment,
            outcome.eventStatus === 'cancelled' ? 'event_cancelled' : 'hold_expired',
          );
          return { outcome: 'refunding_event_unavailable' };
        case 'seats_lost':
        case 'hold_expired':
        case 'not_confirmable':
          // The edge case: the payment went through just after the hold lapsed, and someone
          // else bought the seats in between. Refund automatically; the buyer is emailed.
          await createRefund(trx, payment, 'hold_expired');
          return { outcome: 'refunding_unfulfillable' };
      }
    });
  } catch (err) {
    if (err instanceof AlreadyRecorded) return { outcome: 'already_recorded' };
    throw err;
  }
}

/**
 * Insert a refund and queue its execution. At most one live refund per payment: the partial
 * unique index turns a second attempt into a no-op.
 */
async function createRefund(
  trx: Transaction<DB>,
  payment: Pick<Payment, 'id' | 'amountCents'>,
  reason: RefundReason,
): Promise<string | null> {
  const refund = await trx
    .insertInto('refunds')
    .values({ paymentId: payment.id, amountCents: payment.amountCents, reason })
    .onConflict((oc) => oc.column('paymentId').where('status', '<>', 'failed').doNothing())
    .returning('id')
    .executeTakeFirst();
  if (refund)
    await enqueue(trx, 'payments', 'refund', { refundId: refund.id }, { jobId: `refund_${refund.id}` });
  return refund?.id ?? null;
}

/** The provider says the money went back. Settle our records; end the booking if this paid for it. */
async function completeRefund(paymentId: string): Promise<ReconcileResult> {
  return withTransaction(async (trx) => {
    const { bookingId } = await trx
      .selectFrom('payments')
      .select('bookingId')
      .where('id', '=', paymentId)
      .executeTakeFirstOrThrow();
    const { booking } = await lockBooking(trx, bookingId); // seats → booking
    const payment = await trx
      .selectFrom('payments')
      .selectAll()
      .where('id', '=', paymentId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (payment.status === 'refunded') return { outcome: 'already_refunded' };

    await trx
      .updateTable('payments')
      .set({ status: 'refunded', refundedAt: sql`now()` })
      .where('id', '=', paymentId)
      .execute();
    let refund = await trx
      .updateTable('refunds')
      .set({ status: 'succeeded', completedAt: sql`now()` })
      .where('paymentId', '=', paymentId)
      .where('status', '=', 'pending')
      .returning(['id', 'reason'])
      .executeTakeFirst();
    // A refund issued outside this system (say, from the provider's dashboard): record it.
    refund ??= await trx
      .insertInto('refunds')
      .values({
        paymentId,
        amountCents: payment.amountCents,
        reason: 'requested_by_customer',
        status: 'succeeded',
        completedAt: sql`now()`,
      })
      .returning(['id', 'reason'])
      .executeTakeFirstOrThrow();

    // Only a refund of the payment that paid for the booking ends the booking. Refunding a
    // duplicate or a too-late payment leaves the booking as it is.
    let changes: SeatChange[] = [];
    if (
      booking?.status === 'confirmed' &&
      (refund.reason === 'requested_by_customer' || refund.reason === 'event_cancelled')
    ) {
      changes = await endConfirmedBookingInTx(trx, bookingId, 'refunded');
    }
    await enqueue(
      trx,
      'email',
      'refund-processed',
      { refundId: refund.id },
      { jobId: `refund-processed_${refund.id}` },
    );
    return { outcome: 'refunded', changes };
  });
}

// ─── refunds ─────────────────────────────────────────────────────────────────────────────

/** The buyer asks for their money back (until REFUND_CUTOFF_HOURS before the event). */
export async function requestCustomerRefund(user: AuthUser, bookingId: string) {
  return withTransaction(async (trx) => {
    const { booking } = await lockBooking(trx, bookingId);
    if (!booking || (booking.userId !== user.id && user.role !== 'admin')) throw notFound('Booking');
    if (booking.status !== 'confirmed') {
      throw conflict(
        'BOOKING_NOT_CONFIRMED',
        `Only confirmed bookings can be refunded (status is ${booking.status})`,
      );
    }
    const event = await trx
      .selectFrom('events')
      .select('startsAt')
      .where('id', '=', booking.eventId)
      .executeTakeFirstOrThrow();
    if (event.startsAt.getTime() - Date.now() < config.REFUND_CUTOFF_HOURS * 3_600_000) {
      throw conflict(
        'REFUND_WINDOW_CLOSED',
        `Refunds close ${config.REFUND_CUTOFF_HOURS} hours before the event`,
      );
    }
    const payment = await trx
      .selectFrom('payments')
      .selectAll()
      .where('bookingId', '=', bookingId)
      .where('status', '=', 'succeeded')
      .forUpdate()
      .executeTakeFirst();
    if (!payment) throw conflict('NOTHING_TO_REFUND', 'This booking has no payment to refund');

    await createRefund(trx, payment, 'requested_by_customer');
    // Idempotent: asking twice returns the refund already under way.
    return trx
      .selectFrom('refunds')
      .select(['id', 'status', 'reason', 'amountCents'])
      .where('paymentId', '=', payment.id)
      .where('status', '<>', 'failed')
      .executeTakeFirstOrThrow();
  });
}

/** Job: ask the provider to refund. Retried with backoff; the idempotency key prevents doubles. */
export async function executeRefund(refundId: string) {
  const row = await db
    .selectFrom('refunds as r')
    .innerJoin('payments as p', 'p.id', 'r.paymentId')
    .select(['r.id', 'r.status', 'r.amountCents', 'p.provider', 'p.providerPaymentId'])
    .where('r.id', '=', refundId)
    .executeTakeFirst();
  if (!row || row.status !== 'pending') return { outcome: 'not_pending' };
  if (!row.providerPaymentId)
    throw new UnrecoverableError('refund of a payment that never reached the provider');

  const result = await getPaymentProvider().refundPayment(
    row.providerPaymentId,
    row.amountCents,
    `refund-${row.id}`,
  );
  await db
    .updateTable('refunds')
    .set(
      result.status === 'failed'
        ? { providerRefundId: result.id, status: 'failed', lastError: 'The provider declined the refund' }
        : { providerRefundId: result.id },
    )
    .where('id', '=', refundId)
    .execute();
  if (result.status === 'failed') {
    logger.error({ refundId }, 'refund failed at the provider; needs manual attention');
    return { outcome: 'failed' };
  }
  // Settle now rather than waiting for the webhook (which then finds nothing left to do).
  if (result.status === 'succeeded') return reconcilePayment(row.provider, row.providerPaymentId);
  return { outcome: 'pending' };
}

/** Job: an event was cancelled. Refund every paid booking; void unpaid (free) ones. */
export async function refundEventBookings(eventId: string) {
  let refunds = 0;
  let voided = 0;
  for (;;) {
    const batch = await db
      .selectFrom('bookings as b')
      .leftJoin('payments as p', (join) =>
        join.onRef('p.bookingId', '=', 'b.id').on('p.status', '=', 'succeeded'),
      )
      .select(['b.id as bookingId', 'p.id as paymentId', 'p.amountCents'])
      .where('b.eventId', '=', eventId)
      .where('b.status', '=', 'confirmed')
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('refunds as r')
              .select('r.id')
              .whereRef('r.paymentId', '=', 'p.id')
              .where('r.status', '<>', 'failed'),
          ),
        ),
      )
      .limit(200)
      .execute();
    if (!batch.length) return { refunds, voided };

    for (const row of batch) {
      if (row.paymentId && row.amountCents) {
        const payment = { id: row.paymentId, amountCents: row.amountCents };
        await withTransaction(async (trx) => {
          await lockBooking(trx, row.bookingId); // same lock order as every other writer
          if (await createRefund(trx, payment, 'event_cancelled')) refunds++;
        });
      } else {
        await withTransaction((trx) => endConfirmedBookingInTx(trx, row.bookingId, 'cancelled'));
        voided++;
      }
    }
  }
}
