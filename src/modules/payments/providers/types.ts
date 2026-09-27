/**
 * What the booking system needs from a payment provider. Stripe and the built-in fake gateway
 * both implement it, so the rest of the code never knows which one is configured.
 */
export type ProviderPaymentStatus = 'requires_payment' | 'processing' | 'succeeded' | 'canceled';

export interface ProviderPayment {
  id: string;
  status: ProviderPaymentStatus;
  amountCents: number;
  currency: string;
  refundedCents: number;
  lastError: string | null;
  metadata: Record<string, string>;
}

export interface ProviderEvent {
  id: string;
  type: string;
  /** The payment intent the event is about, or null for unrelated events. */
  providerPaymentId: string | null;
}

export interface CreatePaymentInput {
  amountCents: number;
  currency: string;
  description: string;
  metadata: Record<string, string>;
}

export interface PaymentProvider {
  readonly name: 'fake' | 'stripe';

  /**
   * Create a payment intent. The idempotency key makes retries safe: calling again with the
   * same key returns the same intent instead of creating (and charging) a second one.
   */
  createPayment(
    input: CreatePaymentInput,
    idempotencyKey: string,
  ): Promise<ProviderPayment & { clientSecret: string }>;

  /** The provider's current view of a payment: the source of truth when reconciling. */
  retrievePayment(providerPaymentId: string): Promise<ProviderPayment>;

  /** Full refund. The idempotency key guarantees a retried call never refunds twice. */
  refundPayment(
    providerPaymentId: string,
    amountCents: number,
    idempotencyKey: string,
  ): Promise<{ id: string; status: 'pending' | 'succeeded' | 'failed' }>;

  /** Verify the webhook signature over the raw body and extract the event. Throws if invalid. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ProviderEvent;
}
