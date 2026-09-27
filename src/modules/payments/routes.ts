import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { PAYMENT_STATUSES, REFUND_REASONS, REFUND_STATUSES } from '../../db/types.js';
import { errors, IdParams } from '../../lib/schemas.js';
import { bearerAuth, currentUser, requireAuth } from '../auth/guard.js';
import { ingestWebhook, requestCustomerRefund, startPayment } from './service.js';

export const PaymentDto = z
  .object({
    id: z.uuid(),
    provider: z.string(),
    providerPaymentId: z.string().nullable(),
    clientSecret: z
      .string()
      .nullable()
      .describe('Give this to the payment SDK (Stripe.js or the fake gateway) to pay'),
    amountCents: z.int(),
    currency: z.string(),
    status: z.enum(PAYMENT_STATUSES),
    lastError: z.string().nullable(),
  })
  .meta({ id: 'Payment' });

// Webhooks get their own plugin scope, so only they receive the body as raw bytes. The
// signature is computed over the exact bytes sent; parsing and re-serializing the JSON
// would change them.
const webhookRoutes: FastifyPluginAsyncZod = async (app) => {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.post(
    '/webhooks/:provider',
    {
      schema: {
        tags: ['payments'],
        summary: 'Payment provider webhooks (signature verified)',
        description:
          'Verifies the HMAC signature over the raw body, stores the event once (duplicates are acknowledged and ignored), and queues processing. Answers in milliseconds.',
        params: z.object({ provider: z.string() }),
        response: { 200: z.object({ received: z.literal(true), duplicate: z.boolean() }), ...errors },
      },
    },
    async (req) => {
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const { duplicate } = await ingestWebhook(req.params.provider, body, req.headers);
      return { received: true as const, duplicate };
    },
  );
};

export const paymentRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/bookings/:id/payment',
    {
      onRequest: requireAuth,
      schema: {
        tags: ['payments'],
        summary: 'Start paying for a held booking',
        description:
          'Creates a payment intent at the provider and returns its client secret (201). While a payment is open, calling again returns it (200). ' +
          'The booking becomes confirmed when the provider reports success via webhook; poll GET /bookings/:id.',
        security: bearerAuth,
        params: IdParams,
        response: { 200: PaymentDto, 201: PaymentDto, ...errors },
      },
    },
    async (req, reply) => {
      const { payment, created } = await startPayment(currentUser(req), req.params.id);
      return reply.status(created ? 201 : 200).send(payment);
    },
  );

  app.post(
    '/bookings/:id/refund',
    {
      onRequest: requireAuth,
      schema: {
        tags: ['payments'],
        summary: 'Ask for a refund of a confirmed booking',
        description:
          'Allowed until REFUND_CUTOFF_HOURS (default 24) before the event. The booking becomes refunded, and its seats and tickets are released, when the provider confirms the refund.',
        security: bearerAuth,
        params: IdParams,
        response: {
          202: z.object({
            id: z.uuid(),
            status: z.enum(REFUND_STATUSES),
            reason: z.enum(REFUND_REASONS),
            amountCents: z.int(),
          }),
          ...errors,
        },
      },
    },
    async (req, reply) =>
      reply.status(202).send(await requestCustomerRefund(currentUser(req), req.params.id)),
  );

  await app.register(webhookRoutes);
};
