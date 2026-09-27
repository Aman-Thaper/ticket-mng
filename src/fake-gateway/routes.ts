import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { AppError } from '../lib/errors.js';
import { confirmIntent, GatewayError, getIntent } from './gateway.js';

/**
 * The fake gateway's browser-facing API: what Stripe.js would call. Mounted only when
 * PAYMENT_PROVIDER=fake (never in production). The client secret authorizes each call.
 */
export const fakeGatewayRoutes: FastifyPluginAsyncZod = async (app) => {
  const Intent = z.object({
    id: z.string(),
    status: z.string(),
    amount: z.int(),
    currency: z.string(),
    last_payment_error: z.object({ code: z.string(), message: z.string() }).nullable(),
  });

  const wrap = async <T>(fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof GatewayError)
        throw new AppError(err.statusCode, err.code.toUpperCase(), err.message);
      throw err;
    }
  };
  const view = (i: Awaited<ReturnType<typeof getIntent>>) => ({
    id: i.id,
    status: i.status,
    amount: i.amount,
    currency: i.currency,
    last_payment_error: i.last_payment_error,
  });

  app.post(
    '/fake-gateway/v1/payment_intents/:id/confirm',
    {
      schema: {
        tags: ['fake gateway'],
        summary: 'Pay with a test card (dev only; stands in for Stripe.js)',
        description:
          'Cards: 4242424242424242 succeeds · 4000000000000002 declined · 4000000000009995 insufficient funds · 4000000000000077 processing then success',
        params: z.object({ id: z.string() }),
        body: z.object({ clientSecret: z.string(), cardNumber: z.string() }),
        response: { 200: Intent },
      },
    },
    async (req) =>
      wrap(async () => view(await confirmIntent(req.params.id, req.body.clientSecret, req.body.cardNumber))),
  );

  app.get(
    '/fake-gateway/v1/payment_intents/:id',
    {
      schema: {
        tags: ['fake gateway'],
        summary: 'Payment intent status (dev only)',
        params: z.object({ id: z.string() }),
        querystring: z.object({ client_secret: z.string() }),
        response: { 200: Intent },
      },
    },
    async (req) =>
      wrap(async () => {
        const intent = await getIntent(req.params.id);
        if (intent.client_secret !== req.query.client_secret)
          throw new GatewayError(401, 'invalid_client_secret', 'Invalid client secret');
        return view(intent);
      }),
  );
};
