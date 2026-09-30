import { sql } from 'kysely';
import { config } from '../../config.js';
import { db } from '../../db/index.js';
import {
  bookingConfirmedEmail,
  emailVerificationEmail,
  eventReminderEmail,
  passwordResetEmail,
  refundProcessedEmail,
  type BookingForEmail,
} from '../../emails/templates.js';
import { sendMail } from '../../lib/mailer.js';
import { hashToken, newOpaqueToken } from '../../modules/auth/tokens.js';
import { issueVerificationToken } from '../../modules/auth/verification.js';
import { qrPng, ticketsForBooking } from '../../modules/tickets/service.js';
import type { JobHandler } from '../runner.js';
import type { Jobs } from '../queues.js';

/**
 * Send an email at most once per (kind, refId), however often the job runs.
 *
 * The notification row is locked for the duration of the send. A concurrent duplicate job
 * waits, then sees 'sent' and skips. A retry after a failed send sees 'sending' and tries
 * again. The only remaining duplicate is a crash between the SMTP success and the commit,
 * the unavoidable edge of at-least-once delivery.
 */
export async function sendOnce(
  kind: string,
  refId: string,
  userId: string | null,
  send: () => Promise<void>,
): Promise<'sent' | 'already_sent'> {
  return db.transaction().execute(async (trx) => {
    await trx
      .insertInto('notifications')
      .values({ kind, refId, userId })
      .onConflict((oc) => oc.columns(['kind', 'refId']).doNothing())
      .execute();
    const row = await trx
      .selectFrom('notifications')
      .select('status')
      .where('kind', '=', kind)
      .where('refId', '=', refId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (row.status === 'sent') return 'already_sent';

    await send();
    await trx
      .updateTable('notifications')
      .set({ status: 'sent', sentAt: sql`now()` })
      .where('kind', '=', kind)
      .where('refId', '=', refId)
      .execute();
    return 'sent';
  });
}

async function loadBookingForEmail(bookingId: string) {
  return db
    .selectFrom('bookings as b')
    .innerJoin('users as u', 'u.id', 'b.userId')
    .innerJoin('events as e', 'e.id', 'b.eventId')
    .innerJoin('venues as v', 'v.id', 'e.venueId')
    .select([
      'b.id',
      'b.status',
      'b.totalCents',
      'b.currency',
      'b.userId',
      'u.email',
      'u.name',
      'e.title',
      'e.startsAt',
      'e.status as eventStatus',
      'v.name as venueName',
      'v.address as venueAddress',
      'v.city',
    ])
    .where('b.id', '=', bookingId)
    .executeTakeFirst();
}

type BookingRow = NonNullable<Awaited<ReturnType<typeof loadBookingForEmail>>>;

const forEmail = (b: BookingRow): BookingForEmail => ({
  id: b.id,
  totalCents: b.totalCents,
  currency: b.currency.trim(),
  event: {
    title: b.title,
    startsAt: b.startsAt,
    venueName: b.venueName,
    venueAddress: b.venueAddress,
    city: b.city,
  },
});

/**
 * The API only records "someone asked for a reset for this email". Whether the account
 * exists is decided here, off the request path, so response time can't reveal it.
 */
export const passwordReset: JobHandler<Jobs['email']['password-reset']> = async (job, log) => {
  const user = await db
    .selectFrom('users')
    .select(['id', 'email', 'name'])
    .where('email', '=', job.data.email)
    .executeTakeFirst();
  if (!user) {
    log.info('password reset requested for an unknown email; nothing sent');
    return { sent: false };
  }

  const token = newOpaqueToken();
  await db.transaction().execute(async (trx) => {
    // Only the newest link works.
    await trx
      .updateTable('passwordResetTokens')
      .set({ usedAt: new Date() })
      .where('userId', '=', user.id)
      .where('usedAt', 'is', null)
      .execute();
    await trx
      .insertInto('passwordResetTokens')
      .values({
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + config.PASSWORD_RESET_TTL_MINUTES * 60_000),
      })
      .execute();
  });

  // The token goes in the URL fragment (#), which browsers never send to servers: it can't
  // leak through access logs, proxies or Referer headers.
  await sendMail(
    passwordResetEmail(
      user,
      `${config.APP_URL}/reset-password#token=${token}`,
      config.PASSWORD_RESET_TTL_MINUTES,
    ),
  );
  return { sent: true };
};

/**
 * Sent after signup and on "resend". The token is minted here rather than in the request,
 * so the raw token never sits in the outbox or in Redis. A retry after a failed send mints
 * another one; that's fine, since any unexpired confirmation token works.
 */
export const emailVerification: JobHandler<Jobs['email']['verify-email']> = async (job, log) => {
  const user = await db
    .selectFrom('users')
    .select(['id', 'email', 'name', 'emailVerifiedAt'])
    .where('id', '=', job.data.userId)
    .executeTakeFirst();
  if (!user || user.emailVerifiedAt) {
    log.info('account gone or already confirmed; nothing sent');
    return { sent: false };
  }
  const token = await issueVerificationToken(db, user.id);
  // Like reset links, the token travels in the URL fragment, which browsers never send to servers.
  await sendMail(
    emailVerificationEmail(
      user,
      `${config.APP_URL}/verify-email#token=${token}`,
      config.EMAIL_VERIFICATION_TTL_HOURS,
    ),
  );
  return { sent: true };
};

export const bookingConfirmed: JobHandler<Jobs['email']['booking-confirmed']> = async (job, log) => {
  const booking = await loadBookingForEmail(job.data.bookingId);
  if (!booking || booking.status !== 'confirmed') {
    log.info({ status: booking?.status }, 'booking no longer confirmed; confirmation email skipped');
    return { sent: false };
  }

  const tickets = (await ticketsForBooking(booking.id)).filter((t) => t.status === 'valid');
  const withQr = await Promise.all(tickets.map(async (t) => ({ ...t, qrPng: await qrPng(t.token) })));
  const outcome = await sendOnce('booking-confirmed', booking.id, booking.userId, () =>
    sendMail(bookingConfirmedEmail(booking, forEmail(booking), withQr)),
  );
  return { outcome, tickets: tickets.length };
};

export const eventReminder: JobHandler<Jobs['email']['event-reminder']> = async (job, log) => {
  const booking = await loadBookingForEmail(job.data.bookingId);
  if (
    !booking ||
    booking.status !== 'confirmed' ||
    booking.eventStatus !== 'published' ||
    booking.startsAt <= new Date()
  ) {
    log.info('reminder no longer applies; skipped');
    return { sent: false };
  }
  const seats = (await ticketsForBooking(booking.id))
    .filter((t) => t.status === 'valid')
    .map((t) => `${t.section}, row ${t.row}, seat ${t.number}`);
  const outcome = await sendOnce('event-reminder', booking.id, booking.userId, () =>
    sendMail(eventReminderEmail(booking, forEmail(booking), seats)),
  );
  return { outcome };
};

export const refundProcessed: JobHandler<Jobs['email']['refund-processed']> = async (job) => {
  const refund = await db
    .selectFrom('refunds as r')
    .innerJoin('payments as p', 'p.id', 'r.paymentId')
    .innerJoin('bookings as b', 'b.id', 'p.bookingId')
    .innerJoin('users as u', 'u.id', 'b.userId')
    .innerJoin('events as e', 'e.id', 'b.eventId')
    .select(['r.id', 'r.reason', 'r.amountCents', 'p.currency', 'b.userId', 'u.email', 'u.name', 'e.title'])
    .where('r.id', '=', job.data.refundId)
    .executeTakeFirst();
  if (!refund) return { sent: false };
  const outcome = await sendOnce('refund-processed', refund.id, refund.userId, () =>
    sendMail(
      refundProcessedEmail(refund, {
        reason: refund.reason,
        amountCents: refund.amountCents,
        currency: refund.currency.trim(),
        eventTitle: refund.title,
      }),
    ),
  );
  return { outcome };
};
