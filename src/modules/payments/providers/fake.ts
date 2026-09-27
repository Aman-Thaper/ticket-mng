import { config } from '../../../config.js';
import * as gateway from '../../../fake-gateway/gateway.js';
import { verifyWebhookSignature } from '../signature.js';
import type { PaymentProvider, ProviderEvent, ProviderPayment, ProviderPaymentStatus } from './types.js';

const STATUS: Record<gateway.IntentStatus, ProviderPaymentStatus> = {
  requires_payment_method: 'requires_payment',
  processing: 'processing',
  succeeded: 'succeeded',
  canceled: 'canceled',
};

const toPayment = (i: gateway.FakeIntent): ProviderPayment => ({
  id: i.id,
  status: STATUS[i.status],
  amountCents: i.amount,
  currency: i.currency.toUpperCase(),
  refundedCents: i.amount_refunded,
  lastError: i.last_payment_error?.message ?? null,
  metadata: i.metadata,
});

/**
 * Adapter for the built-in fake gateway. A real provider would be called over HTTP; the fake
 * one lives in-process, but everything that matters (idempotency keys, signed webhooks,
 * at-least-once delivery) behaves the same.
 */
export class FakeProvider implements PaymentProvider {
  readonly name = 'fake' as const;

  async createPayment(input: Parameters<PaymentProvider['createPayment']>[0], idempotencyKey: string) {
    const intent = await gateway.createIntent(
      {
        amount: input.amountCents,
        currency: input.currency,
        description: input.description,
        metadata: input.metadata,
      },
      idempotencyKey,
    );
    return { ...toPayment(intent), clientSecret: intent.client_secret };
  }

  async retrievePayment(id: string) {
    return toPayment(await gateway.getIntent(id));
  }

  async refundPayment(id: string, amountCents: number, idempotencyKey: string) {
    return gateway.refundIntent(id, amountCents, idempotencyKey);
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ProviderEvent {
    verifyWebhookSignature(rawBody, headers['fake-signature'], config.FAKE_GATEWAY_WEBHOOK_SECRET);
    const event = JSON.parse(rawBody.toString('utf8')) as gateway.FakeEvent;
    const object = event.data.object as { object?: string; id?: string; payment_intent?: string };
    return {
      id: event.id,
      type: event.type,
      providerPaymentId:
        object.object === 'payment_intent' ? (object.id ?? null) : (object.payment_intent ?? null),
    };
  }
}
