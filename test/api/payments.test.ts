import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/index.js';
import { config } from '../../src/config.js';
import * as gateway from '../../src/fake-gateway/gateway.js';
import { signWebhookPayload } from '../../src/modules/payments/signature.js';
import { reconcilePayment } from '../../src/modules/payments/service.js';
import { sentMail } from '../../src/lib/mailer.js';
import {
  createEvent,
  createUser,
  createVenue,
  inDays,
  payFor,
  publish,
  runQueuedJobs,
  TEST_CARDS,
  useApp,
  type TestUser,
} from '../helpers.js';

describe('payments', () => {
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

  const hold = async (
    user: TestUser,
    seats: number[],
    event = eventId,
    headers: Record<string, string> = {},
  ) =>
    t.app.inject({
      method: 'POST',
      url: `/api/v1/events/${event}/bookings`,
      headers: { ...user.auth, ...headers },
      payload: { seatIds: seats },
    });
  const booking = async (id: string, user = buyer) =>
    (await t.app.inject({ url: `/api/v1/bookings/${id}`, headers: user.auth })).json();
  const startPayment = (id: string, user = buyer) =>
    t.app.inject({ method: 'POST', url: `/api/v1/bookings/${id}/payment`, headers: user.auth });
  const payAtGateway = (
    payment: { providerPaymentId: string; clientSecret: string },
    card: string = TEST_CARDS.ok,
  ) =>
    t.app.inject({
      method: 'POST',
      url: `/fake-gateway/v1/payment_intents/${payment.providerPaymentId}/confirm`,
      payload: { clientSecret: payment.clientSecret, cardNumber: card },
    });
  const lapse = (bookingId: string) =>
    db
      .updateTable('bookings')
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where('id', '=', bookingId)
      .execute();
  const seatRow = (id: number) =>
    db
      .selectFrom('eventSeats')
      .select(['status', 'bookingId'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

  beforeEach(async () => {
    [organizer, buyer] = await Promise.all([createUser('organizer'), createUser('attendee')]);
    ({ id: eventId, seatIds } = await openEvent());
  });

  describe('paying', () => {
    it('card succeeds → webhook → booking confirmed, tickets issued, confirmation emailed', async () => {
      const b = (await hold(buyer, [seatIds[0]!, seatIds[1]!])).json();
      const { payment, gateway: gw } = await payFor(t.app, buyer, b.id);
      expect(gw.json().status).toBe('succeeded');
      expect(payment).toMatchObject({
        provider: 'fake',
        amountCents: 16_000,
        currency: 'USD',
        status: 'requires_payment',
      });

      expect(await booking(b.id)).toMatchObject({
        status: 'confirmed',
        payment: { status: 'succeeded' },
        refund: null,
      });
      expect(await seatRow(seatIds[0]!)).toEqual({ status: 'booked', bookingId: b.id });
      expect(await db.selectFrom('tickets').selectAll().where('bookingId', '=', b.id).execute()).toHaveLength(
        2,
      );
      expect(sentMail.map((m) => m.subject)).toEqual(['Your tickets: Test Concert']);
    });

    it('a declined card leaves the booking pending; paying again with a good card works', async () => {
      const b = (await hold(buyer, [seatIds[0]!])).json();
      const payment = (await startPayment(b.id)).json();
      await payAtGateway(payment, TEST_CARDS.declined);
      await runQueuedJobs();
      expect(await booking(b.id)).toMatchObject({
        status: 'pending',
        payment: { status: 'requires_payment', lastError: 'Your card was declined.' },
      });

      // Same open payment is reused: no second intent.
      const again = await startPayment(b.id);
      expect(again.statusCode).toBe(200);
      expect(again.json().providerPaymentId).toBe(payment.providerPaymentId);
      await payAtGateway(payment, TEST_CARDS.ok);
      await runQueuedJobs();
      expect((await booking(b.id)).status).toBe('confirmed');
    });

    it('a slow card goes through processing, then succeeds', async () => {
      const b = (await hold(buyer, [seatIds[0]!])).json();
      const { jobs } = await payFor(t.app, buyer, b.id, TEST_CARDS.slow);
      expect(jobs.filter((j) => j.name === 'payments/process-webhook')).toHaveLength(2);
      expect((await booking(b.id)).status).toBe('confirmed');
    });

    it('starting payment twice returns the same payment (201, then 200)', async () => {
      const b = (await hold(buyer, [seatIds[0]!])).json();
      const first = await startPayment(b.id);
      const second = await startPayment(b.id);
      expect([first.statusCode, second.statusCode]).toEqual([201, 200]);
      expect(second.json().id).toBe(first.json().id);
    });

    it('only the buyer can pay, and the gateway checks the client secret', async () => {
      const b = (await hold(buyer, [seatIds[0]!])).json();
      expect((await startPayment(b.id, await createUser('attendee'))).statusCode).toBe(404);
      const payment = (await startPayment(b.id)).json();
      const res = await payAtGateway({ ...payment, clientSecret: 'nope' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('webhooks', () => {
    const post = (body: string, headers: Record<string, string>) =>
      t.app.inject({
        method: 'POST',
        url: '/api/v1/webhooks/fake',
        payload: body,
        headers: { 'content-type': 'application/json', ...headers },
      });
    const event = (id: string, piId: string) =>
      JSON.stringify({
        id,
        object: 'event',
        type: 'payment_intent.succeeded',
        created: 1,
        data: { object: { object: 'payment_intent', id: piId } },
      });

    it('rejects unsigned, forged and replayed webhooks', async () => {
      const body = event('evt_x', 'pi_x');
      expect((await post(body, {})).json().error.code).toBe('INVALID_SIGNATURE');
      expect(
        (await post(body, { 'fake-signature': signWebhookPayload(body, 'whsec_wrong_secret_1234') }))
          .statusCode,
      ).toBe(400);
      const old = signWebhookPayload(
        body,
        config.FAKE_GATEWAY_WEBHOOK_SECRET,
        Math.floor(Date.now() / 1000) - 3600,
      );
      expect((await post(body, { 'fake-signature': old })).json().error.message).toMatch(/replay/);
      expect(await db.selectFrom('webhookEvents').selectAll().execute()).toHaveLength(0);
    });

    it('acknowledges duplicates without processing them twice', async () => {
      const b = (await hold(buyer, [seatIds[0]!])).json();
      const payment = (await startPayment(b.id)).json();
      gateway.configureDelivery({ mode: 'sync', deliverer: async () => 200 }); // swallow the real delivery
      try {
        await payAtGateway(payment);
      } finally {
        gateway.configureDelivery({
          deliverer: async (body, headers) =>
            (await t.app.inject({ method: 'POST', url: '/api/v1/webhooks/fake', payload: body, headers }))
              .statusCode,
        });
      }

      const body = event('evt_dup', payment.providerPaymentId);
      const headers = { 'fake-signature': signWebhookPayload(body, config.FAKE_GATEWAY_WEBHOOK_SECRET) };
      expect((await post(body, headers)).json()).toEqual({ received: true, duplicate: false });
      expect((await post(body, headers)).json()).toEqual({ received: true, duplicate: true });
      expect((await runQueuedJobs()).filter((j) => j.name === 'payments/process-webhook')).toHaveLength(1);
      expect((await booking(b.id)).status).toBe('confirmed');
    });

    it('converges when events arrive out of order: "processing" after "succeeded" changes nothing', async () => {
      const b = (await hold(buyer, [seatIds[0]!])).json();
      const payment = (await startPayment(b.id)).json();
      const captured: string[] = [];
      gateway.configureDelivery({ mode: 'sync', deliverer: async (body) => (captured.push(body), 200) });
      try {
        await payAtGateway(payment, TEST_CARDS.slow); // emits processing, then succeeded
      } finally {
        gateway.configureDelivery({
          deliverer: async (body, headers) =>
            (await t.app.inject({ method: 'POST', url: '/api/v1/webhooks/fake', payload: body, headers }))
              .statusCode,
        });
      }
      expect(captured.map((c) => JSON.parse(c).type)).toEqual([
        'payment_intent.processing',
        'payment_intent.succeeded',
      ]);

      for (const body of captured.reverse()) {
        await post(body, { 'fake-signature': signWebhookPayload(body, config.FAKE_GATEWAY_WEBHOOK_SECRET) });
        await runQueuedJobs();
      }
      expect(await booking(b.id)).toMatchObject({ status: 'confirmed', payment: { status: 'succeeded' } });
    });

    it('404s for a provider that is not configured', async () => {
      expect(
        (await t.app.inject({ method: 'POST', url: '/api/v1/webhooks/stripe', payload: '{}' })).statusCode,
      ).toBe(404);
    });
  });

  describe('the late payment edge case', () => {
    it('payment lands after the hold lapsed, seats still free → re-takes them and confirms', async () => {
      const b = (await hold(buyer, [seatIds[0]!])).json();
      const payment = (await startPayment(b.id)).json();
      await lapse(b.id);
      await payAtGateway(payment);
      await runQueuedJobs();
      expect(await booking(b.id)).toMatchObject({ status: 'confirmed', refund: null });
      expect(await seatRow(seatIds[0]!)).toEqual({ status: 'booked', bookingId: b.id });
    });

    it('payment lands after someone else bought the seats → automatic full refund + email', async () => {
      const b = (await hold(buyer, [seatIds[0]!])).json();
      const payment = (await startPayment(b.id)).json();
      await lapse(b.id);
      const rival = await createUser('attendee');
      const rivalBooking = (await hold(rival, [seatIds[0]!])).json();

      await payAtGateway(payment);
      await runQueuedJobs(); // webhook → refund created → refund job → gateway refund → webhook → settled

      expect(await booking(b.id)).toMatchObject({
        status: 'expired',
        payment: { status: 'refunded' },
        refund: { status: 'succeeded', reason: 'hold_expired' },
      });
      expect((await gateway.getIntent(payment.providerPaymentId)).amount_refunded).toBe(8000);
      expect(await seatRow(seatIds[0]!)).toEqual({ status: 'held', bookingId: rivalBooking.id }); // untouched
      expect(sentMail.map((m) => m.subject)).toEqual(['Payment refunded: Test Concert']);
    });

    it('a second payment for an already-paid booking is refunded as a duplicate', async () => {
      const b = (await hold(buyer, [seatIds[0]!])).json();
      await payFor(t.app, buyer, b.id);

      // A second charge for the same booking (say, paid again on another device).
      const intent = await gateway.createIntent(
        { amount: 8000, currency: 'USD', description: 'dup', metadata: { bookingId: b.id } },
        'dup-test',
      );
      await db
        .insertInto('payments')
        .values({
          bookingId: b.id,
          provider: 'fake',
          providerPaymentId: intent.id,
          amountCents: 8000,
          currency: 'USD',
        })
        .execute();
      gateway.configureDelivery({ mode: 'sync', deliverer: async () => 200 });
      try {
        await gateway.confirmIntent(intent.id, intent.client_secret, TEST_CARDS.ok);
      } finally {
        gateway.configureDelivery({
          deliverer: async (body, headers) =>
            (await t.app.inject({ method: 'POST', url: '/api/v1/webhooks/fake', payload: body, headers }))
              .statusCode,
        });
      }

      expect(await reconcilePayment('fake', intent.id)).toEqual({ outcome: 'refunding_duplicate' });
      await runQueuedJobs();
      const refund = await db.selectFrom('refunds').selectAll().executeTakeFirstOrThrow();
      expect(refund).toMatchObject({ reason: 'duplicate_payment', status: 'succeeded' });
      expect((await booking(b.id)).status).toBe('confirmed'); // the booking itself is fine
    });
  });

  describe('refunds', () => {
    const refund = (id: string, user = buyer) =>
      t.app.inject({ method: 'POST', url: `/api/v1/bookings/${id}/refund`, headers: user.auth });

    it('customer refund: money returned, then seats released and tickets voided', async () => {
      const b = (await hold(buyer, [seatIds[0]!])).json();
      await payFor(t.app, buyer, b.id);
      sentMail.length = 0;

      const res = await refund(b.id);
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({
        status: 'pending',
        reason: 'requested_by_customer',
        amountCents: 8000,
      });
      expect((await refund(b.id)).json().id).toBe(res.json().id); // asking twice is harmless

      await runQueuedJobs();
      expect(await booking(b.id)).toMatchObject({
        status: 'refunded',
        refundedAt: expect.any(String),
        refund: { status: 'succeeded' },
      });
      expect(await seatRow(seatIds[0]!)).toEqual({ status: 'available', bookingId: null });
      const tickets = await db.selectFrom('tickets').select('status').where('bookingId', '=', b.id).execute();
      expect(tickets.map((x) => x.status)).toEqual(['void']);
      expect(sentMail.map((m) => m.subject)).toEqual(['Refund processed: Test Concert']);
      expect((await refund(b.id)).json().error.code).toBe('BOOKING_NOT_CONFIRMED');
    });

    it('refunds close 24 hours before the event', async () => {
      const soon = await openEvent({ startsAt: inDays(0, 12), endsAt: inDays(0, 15) });
      const b = (await hold(buyer, [soon.seatIds[0]!], soon.id)).json();
      await payFor(t.app, buyer, b.id);
      expect((await refund(b.id)).json().error.code).toBe('REFUND_WINDOW_CLOSED');
    });

    it('cancelling an event refunds every paid booking and voids open holds', async () => {
      const other = await createUser('attendee');
      const paid1 = (await hold(buyer, [seatIds[0]!])).json();
      await payFor(t.app, buyer, paid1.id);
      const paid2 = (await hold(other, [seatIds[1]!])).json();
      await payFor(t.app, other, paid2.id);
      const pending = (await hold(await createUser('attendee'), [seatIds[2]!])).json();
      sentMail.length = 0;

      await t.app.inject({
        method: 'PATCH',
        url: `/api/v1/events/${eventId}`,
        headers: organizer.auth,
        payload: { status: 'cancelled' },
      });
      await runQueuedJobs();

      for (const [id, user] of [
        [paid1.id, buyer],
        [paid2.id, other],
      ] as const) {
        expect(await booking(id, user)).toMatchObject({
          status: 'refunded',
          refund: { reason: 'event_cancelled', status: 'succeeded' },
        });
      }
      expect(
        (
          await db
            .selectFrom('bookings')
            .select('status')
            .where('id', '=', pending.id)
            .executeTakeFirstOrThrow()
        ).status,
      ).toBe('cancelled');
      expect(sentMail.map((m) => m.subject).sort()).toEqual([
        'Cancelled: Test Concert',
        'Cancelled: Test Concert',
      ]);
    });
  });

  describe('Idempotency-Key', () => {
    it('replays the original response for a retried request, and books only once', async () => {
      const headers = { 'idempotency-key': 'retry-me-123' };
      const first = await hold(buyer, [seatIds[0]!], eventId, headers);
      const retry = await hold(buyer, [seatIds[0]!], eventId, headers);
      expect(first.statusCode).toBe(201);
      expect(retry.statusCode).toBe(201);
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.json().id).toBe(first.json().id);
      expect(await db.selectFrom('bookings').selectAll().execute()).toHaveLength(1);
    });

    it('refuses to reuse a key for a different request', async () => {
      const headers = { 'idempotency-key': 'one-key' };
      await hold(buyer, [seatIds[0]!], eventId, headers);
      const res = await hold(buyer, [seatIds[1]!], eventId, headers);
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('concurrent duplicates run the work once', async () => {
      const headers = { 'idempotency-key': 'double-click' };
      const results = await Promise.all(
        Array.from({ length: 5 }, () => hold(buyer, [seatIds[0]!], eventId, headers)),
      );
      const ok = results.filter((r) => r.statusCode === 201);
      expect(ok.length).toBeGreaterThanOrEqual(1);
      expect(new Set(ok.map((r) => r.json().id)).size).toBe(1);
      for (const r of results) expect([201, 409]).toContain(r.statusCode);
      expect(await db.selectFrom('bookings').selectAll().execute()).toHaveLength(1);
    });

    it('a failed request does not burn the key', async () => {
      const headers = { 'idempotency-key': 'try-again-later' };
      const blocker = (await hold(await createUser('attendee'), [seatIds[0]!])).json();
      expect((await hold(buyer, [seatIds[0]!], eventId, headers)).statusCode).toBe(409);

      await lapse(blocker.id); // the other hold ends, freeing the seat
      expect((await hold(buyer, [seatIds[0]!], eventId, headers)).statusCode).toBe(201);
    });
  });
});
