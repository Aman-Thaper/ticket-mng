import { describe, expect, it } from 'vitest';
import Stripe from 'stripe';
import { StripeProvider } from '../../src/modules/payments/providers/stripe.js';

// Runs only where Stripe's official API mock is available (CI starts it as a service):
//   docker run -p 12111:12111 stripe/stripe-mock  →  STRIPE_MOCK_URL=http://localhost:12111
// stripe-mock validates every request against Stripe's OpenAPI spec, so this proves our
// provider sends requests Stripe would accept, without a Stripe account.
const mockUrl = process.env.STRIPE_MOCK_URL;

describe.skipIf(!mockUrl)('StripeProvider against stripe-mock', () => {
  const url = new URL(mockUrl ?? 'http://localhost:12111');
  const stripe = new Stripe('sk_test_123', {
    host: url.hostname,
    port: Number(url.port),
    protocol: url.protocol === 'https:' ? 'https' : 'http',
  });
  const provider = new StripeProvider(stripe, 'whsec_unused');

  it('creates, retrieves and refunds a payment intent with requests Stripe accepts', async () => {
    const created = await provider.createPayment(
      {
        amountCents: 5000,
        currency: 'USD',
        description: 'Booking test',
        metadata: { bookingId: 'b1', paymentId: 'p1' },
      },
      'idem-create-1',
    );
    expect(created.id).toMatch(/^pi_/);
    expect(created.clientSecret).toBeTruthy();

    const fetched = await provider.retrievePayment(created.id);
    expect(fetched.id).toMatch(/^pi_/);
    expect(['requires_payment', 'processing', 'succeeded', 'canceled']).toContain(fetched.status);

    const refund = await provider.refundPayment(created.id, 5000, 'idem-refund-1');
    expect(refund.id).toMatch(/^re_/);
    expect(['pending', 'succeeded', 'failed']).toContain(refund.status);
  });
});
