import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { db } from '../../src/db/index.js';
import { withTransaction } from '../../src/db/transaction.js';
import { confirmBooking } from '../../src/modules/bookings/service.js';
import { handlers } from '../../src/jobs/handlers/index.js';
import { cleanup, sendEventReminders } from '../../src/jobs/handlers/maintenance.js';
import { bookingConfirmed, eventReminder } from '../../src/jobs/handlers/email.js';
import { sweepExpiredHolds } from '../../src/jobs/handlers/bookings.js';
import { enqueue, OutboxRelay, publishOutboxBatch } from '../../src/jobs/outbox.js';
import { DEAD_LETTER_QUEUE, getQueue } from '../../src/jobs/queues.js';
import { createWorker } from '../../src/jobs/runner.js';
import { logger } from '../../src/lib/logger.js';
import { sentMail } from '../../src/lib/mailer.js';
import {
  createEvent,
  createUser,
  createVenue,
  inDays,
  publish,
  runQueuedJobs,
  useApp,
  type TestUser,
} from '../helpers.js';

// Handlers are plain functions; tests call them with a minimal job object.
const job = <T>(data: T) => ({ id: 'test', name: 'test', data, attemptsMade: 0, opts: {} }) as never;

describe('background jobs', () => {
  const t = useApp();
  let organizer: TestUser;
  let buyer: TestUser;
  let eventId: string;
  let seatIds: number[];

  async function openEvent(overrides: Record<string, unknown> = {}) {
    const venueId = (await createVenue(t.app, organizer)).id;
    const id = (await createEvent(t.app, organizer, venueId, overrides)).json().id as string;
    await publish(t.app, organizer, id);
    const map = (await t.app.inject({ url: `/api/v1/events/${id}/seats` })).json();
    return { id, seatIds: map.sections[0].seats.map((s: { id: number }) => s.id) as number[] };
  }

  const hold = (seats: number[], app: FastifyInstance = t.app, user = buyer, event = eventId) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/events/${event}/bookings`,
      headers: user.auth,
      payload: { seatIds: seats },
    });
  // Confirm directly (no payment) so these tests exercise the jobs, not the payment flow.
  const confirm = (bookingId: string) => confirmBooking(bookingId);

  beforeEach(async () => {
    [organizer, buyer] = await Promise.all([createUser('organizer'), createUser('attendee')]);
    ({ id: eventId, seatIds } = await openEvent());
  });

  describe('transactional outbox', () => {
    it('queues nothing if the transaction rolls back, and exactly one row if it commits', async () => {
      await expect(
        withTransaction(async (trx) => {
          await enqueue(trx, 'email', 'password-reset', { email: 'a@example.com' });
          throw new Error('business logic failed');
        }),
      ).rejects.toThrow('business logic failed');
      expect(await db.selectFrom('outbox').selectAll().execute()).toHaveLength(0);

      await withTransaction((trx) => enqueue(trx, 'email', 'password-reset', { email: 'a@example.com' }));
      expect(await db.selectFrom('outbox').selectAll().execute()).toHaveLength(1);
    });

    it('publishes to BullMQ with the requested delay, and publishing twice is harmless', async () => {
      const runAt = new Date(Date.now() + 60_000);
      await enqueue(
        db,
        'bookings',
        'expire-booking',
        { bookingId: 'b1' },
        { jobId: 'expire-booking_b1', runAt },
      );
      expect(await publishOutboxBatch()).toBe(1);
      expect(await publishOutboxBatch()).toBe(0);

      const queued = await getQueue('bookings').getJob('expire-booking_b1');
      expect(queued?.data).toMatchObject({ bookingId: 'b1' });
      expect(queued!.opts.delay).toBeGreaterThan(55_000);

      // Simulate a crash after publishing but before marking the row published.
      await db.updateTable('outbox').set({ publishedAt: null }).execute();
      expect(await publishOutboxBatch()).toBe(1);
      expect(await getQueue('bookings').getJobCounts('delayed')).toEqual({ delayed: 1 });
    });
  });

  describe('end to end: outbox → relay → BullMQ → worker', () => {
    it('confirming a booking emails the signed QR tickets', async () => {
      const booking = (await hold(seatIds.slice(0, 2))).json();
      await confirm(booking.id);

      const relay = new OutboxRelay(100);
      const worker = createWorker('email', handlers.email, 5);
      await relay.start();
      try {
        await expect.poll(() => sentMail.length, { timeout: 10_000 }).toBe(1);
      } finally {
        await relay.stop();
        await worker.close();
      }

      const mail = sentMail[0]!;
      expect(mail).toMatchObject({ to: buyer.email, subject: 'Your tickets: Test Concert' });
      expect(mail.attachments).toHaveLength(2);
      for (const a of mail.attachments!) expect(mail.html).toContain(`cid:${a.cid}`);
    });

    it("releases an unpaid hold's seats when its delayed expiry job fires", async () => {
      const app = await buildApp({ logger: false }, { booking: { holdTtlSeconds: 1 } });
      const relay = new OutboxRelay(100);
      const worker = createWorker('bookings', handlers.bookings, 5);
      try {
        const booking = (await hold([seatIds[0]!], app)).json();
        await relay.start();
        await expect
          .poll(
            async () =>
              (
                await db
                  .selectFrom('bookings')
                  .select('status')
                  .where('id', '=', booking.id)
                  .executeTakeFirstOrThrow()
              ).status,
            { timeout: 10_000, interval: 200 },
          )
          .toBe('expired');
        const seat = await db
          .selectFrom('eventSeats')
          .select(['status', 'bookingId'])
          .where('id', '=', seatIds[0]!)
          .executeTakeFirstOrThrow();
        expect(seat).toEqual({ status: 'available', bookingId: null });
      } finally {
        await relay.stop();
        await worker.close();
        await app.close();
      }
    });
  });

  describe('retries and the dead-letter queue', () => {
    const admin = () => createUser('admin');

    it('retries with backoff, then dead-letters the job with its error; admins can inspect and requeue it', async () => {
      let attempts = 0;
      const worker = createWorker(
        'maintenance',
        {
          flaky: async () => {
            attempts++;
            throw new Error('smtp exploded');
          },
        },
        1,
      );
      try {
        await getQueue('maintenance').add(
          'flaky',
          { n: 1 },
          { attempts: 3, backoff: { type: 'fixed', delay: 50 } },
        );
        await expect.poll(() => getQueue(DEAD_LETTER_QUEUE).count(), { timeout: 10_000 }).toBe(1);
      } finally {
        await worker.close();
      }
      expect(attempts).toBe(3);

      const auth = (await admin()).auth;
      const letters = (await t.app.inject({ url: '/api/v1/admin/dead-letters', headers: auth })).json();
      expect(letters).toEqual([
        expect.objectContaining({
          queue: 'maintenance',
          name: 'flaky',
          error: 'smtp exploded',
          attemptsMade: 3,
          data: { n: 1 },
        }),
      ]);

      const retry = await t.app.inject({
        method: 'POST',
        url: `/api/v1/admin/dead-letters/${letters[0].id}/retry`,
        headers: auth,
      });
      expect(retry.statusCode).toBe(202);
      expect(await getQueue(DEAD_LETTER_QUEUE).count()).toBe(0);
      expect(await getQueue('maintenance').getJob(retry.json().requeuedAs)).toBeDefined();
    });

    it('sends permanent failures straight to the dead-letter queue, without retrying', async () => {
      const worker = createWorker('maintenance', {}, 1); // no handler → UnrecoverableError
      try {
        await getQueue('maintenance').add('mystery-job', {});
        await expect.poll(() => getQueue(DEAD_LETTER_QUEUE).count(), { timeout: 10_000 }).toBe(1);
      } finally {
        await worker.close();
      }
      const [letter] = await getQueue(DEAD_LETTER_QUEUE).getJobs(['waiting']);
      expect(letter!.data).toMatchObject({
        name: 'mystery-job',
        attemptsMade: 1,
        error: expect.stringContaining('No handler'),
      });
    });

    it('only admins can see the queues', async () => {
      expect((await t.app.inject({ url: '/api/v1/admin/queues', headers: organizer.auth })).statusCode).toBe(
        403,
      );
      const res = await t.app.inject({ url: '/api/v1/admin/queues', headers: (await admin()).auth });
      expect(res.json()).toMatchObject({
        queues: expect.arrayContaining([expect.objectContaining({ name: 'email' })]),
        outbox: { unpublished: 0 },
      });
    });
  });

  describe('handlers', () => {
    it('sends the confirmation email once, however many times the job runs', async () => {
      const booking = (await hold([seatIds[0]!])).json();
      await confirm(booking.id);
      await runQueuedJobs();
      expect(sentMail).toHaveLength(1);
      expect(await bookingConfirmed(job({ bookingId: booking.id }), logger)).toMatchObject({
        outcome: 'already_sent',
      });
      expect(sentMail).toHaveLength(1);
    });

    it('the sweeper releases lapsed holds that no expiry job released', async () => {
      const booking = (await hold([seatIds[0]!, seatIds[1]!])).json();
      await db
        .updateTable('bookings')
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .execute();
      expect(await sweepExpiredHolds(job({}), logger)).toEqual({ bookings: 1, released: 2 });
      expect(
        (
          await db
            .selectFrom('bookings')
            .select('status')
            .where('id', '=', booking.id)
            .executeTakeFirstOrThrow()
        ).status,
      ).toBe('expired');
      expect(await sweepExpiredHolds(job({}), logger)).toEqual({ bookings: 0, released: 0 });
    });

    it('queues one reminder per booking for events starting in about 24 hours', async () => {
      const soon = await openEvent({ startsAt: inDays(1), endsAt: inDays(1, 3) });
      const later = await openEvent({ startsAt: inDays(3), endsAt: inDays(3, 3) });
      const b1 = (await hold([soon.seatIds[0]!], t.app, buyer, soon.id)).json();
      await confirm(b1.id);
      const b2 = (await hold([later.seatIds[0]!], t.app, buyer, later.id)).json();
      await confirm(b2.id);

      expect(await sendEventReminders(job({}), logger)).toEqual({ queued: 1 });
      expect(await getQueue('email').getJob(`event-reminder_${b1.id}`)).toBeDefined();

      await eventReminder(job({ bookingId: b1.id }), logger);
      await eventReminder(job({ bookingId: b1.id }), logger);
      expect(sentMail.filter((m) => m.subject.startsWith('Tomorrow'))).toHaveLength(1);
      expect(await sendEventReminders(job({}), logger)).toEqual({ queued: 0 }); // already reminded
    });

    it('cleanup removes rows nothing will read again', async () => {
      await enqueue(db, 'email', 'password-reset', { email: 'x@example.com' });
      await db
        .updateTable('outbox')
        .set({ publishedAt: sql<Date>`now() - interval '8 days'` })
        .execute();
      await db
        .updateTable('refreshTokens')
        .set({ expiresAt: sql<Date>`now() - interval '2 days'` })
        .execute();

      const result = (await cleanup(job({}), logger)) as Record<string, number>;
      expect(result).toMatchObject({ outbox: 1 });
      expect(result.refreshTokens).toBeGreaterThan(0);
      expect(await db.selectFrom('outbox').selectAll().execute()).toHaveLength(0);
    });
  });
});
