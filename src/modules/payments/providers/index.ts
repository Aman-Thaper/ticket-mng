import Stripe from 'stripe';
import { config } from '../../../config.js';
import { FakeProvider } from './fake.js';
import { StripeProvider } from './stripe.js';
import type { PaymentProvider } from './types.js';

let provider: PaymentProvider | undefined;

/** The configured payment provider (PAYMENT_PROVIDER). */
export function getPaymentProvider(): PaymentProvider {
  provider ??=
    config.PAYMENT_PROVIDER === 'stripe'
      ? new StripeProvider(
          new Stripe(config.STRIPE_SECRET_KEY!, { maxNetworkRetries: 2 }),
          config.STRIPE_WEBHOOK_SECRET!,
        )
      : new FakeProvider();
  return provider;
}

/** Tests only: swap in a stub provider. */
export function setPaymentProvider(p: PaymentProvider | undefined): void {
  provider = p;
}

export type { PaymentProvider } from './types.js';
