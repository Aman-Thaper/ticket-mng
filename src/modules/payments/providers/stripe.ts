import type Stripe from 'stripe';
import { verifyWebhookSignature } from '../signature.js';
import type { PaymentProvider, ProviderEvent, ProviderPayment, ProviderPaymentStatus } from './types.js';

type Intent = Awaited<ReturnType<Stripe['paymentIntents']['retrieve']>>;

export function mapStripeStatus(status: Intent['status']): ProviderPaymentStatus {
  switch (status) {
    case 'succeeded':
      return 'succeeded';
    case 'processing':
    case 'requires_capture': // we capture automatically, so this is in flight
      return 'processing';
    case 'canceled':
      return 'canceled';
    case 'requires_payment_method':
    case 'requires_confirmation':
    case 'requires_action':
      return 'requires_payment';
    default:
      // A status newer than this SDK's types: safest to treat it as not yet paid.
      return 'requires_payment';
  }
}

export function toProviderPayment(pi: Intent): ProviderPayment {
  const charge = pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
  return {
    id: pi.id,
    status: mapStripeStatus(pi.status),
    amountCents: pi.amount,
    currency: pi.currency.toUpperCase(),
    refundedCents: charge?.amount_refunded ?? 0,
    lastError: pi.last_payment_error?.message ?? null,
    metadata: pi.metadata,
  };
}

/**
 * Stripe (test mode) via the official SDK. The webhook signature is checked with the shared
 * verifier, the same scheme Stripe's own constructEvent() implements (see
 * test/unit/webhook-signature.test.ts).
 */
export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe' as const;

  constructor(
    private readonly stripe: Stripe,
    private readonly webhookSecret: string,
  ) {}

  async createPayment(input: Parameters<PaymentProvider['createPayment']>[0], idempotencyKey: string) {
    const pi = await this.stripe.paymentIntents.create(
      {
        amount: input.amountCents,
        currency: input.currency.toLowerCase(),
        description: input.description,
        metadata: input.metadata,
        automatic_payment_methods: { enabled: true },
      },
      { idempotencyKey },
    );
    return { ...toProviderPayment(pi), clientSecret: pi.client_secret! };
  }

  async retrievePayment(id: string) {
    return toProviderPayment(await this.stripe.paymentIntents.retrieve(id, { expand: ['latest_charge'] }));
  }

  async refundPayment(id: string, amountCents: number, idempotencyKey: string) {
    const refund = await this.stripe.refunds.create(
      { payment_intent: id, amount: amountCents },
      { idempotencyKey },
    );
    const status: 'pending' | 'succeeded' | 'failed' =
      refund.status === 'succeeded'
        ? 'succeeded'
        : refund.status === 'failed' || refund.status === 'canceled'
          ? 'failed'
          : 'pending';
    return { id: refund.id, status };
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ProviderEvent {
    verifyWebhookSignature(rawBody, headers['stripe-signature'], this.webhookSecret);
    const event = JSON.parse(rawBody.toString('utf8')) as {
      id: string;
      type: string;
      data: { object: Record<string, unknown> };
    };
    const object = event.data.object as {
      object?: string;
      id?: string;
      payment_intent?: string | { id: string } | null;
    };
    const fromCharge =
      typeof object.payment_intent === 'string' ? object.payment_intent : (object.payment_intent?.id ?? null);
    return {
      id: event.id,
      type: event.type,
      providerPaymentId: object.object === 'payment_intent' ? (object.id ?? null) : fromCharge,
    };
  }
}
