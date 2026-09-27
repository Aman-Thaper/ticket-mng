import { describe, expect, it } from 'vitest';
import Stripe from 'stripe';
import {
  mapStripeStatus,
  StripeProvider,
  toProviderPayment,
} from '../../src/modules/payments/providers/stripe.js';

// No network: these check our translation of Stripe's objects and webhooks. A full run
// against Stripe's official mock server (stripe-mock) happens in CI.

const secret = 'whsec_unit_test_secret';
const stripe = new Stripe('sk_test_unused');
const provider = new StripeProvider(stripe, secret);

const signed = (event: object) => {
  const body = JSON.stringify(event);
  return {
    body: Buffer.from(body),
    headers: { 'stripe-signature': stripe.webhooks.generateTestHeaderString({ payload: body, secret }) },
  };
};

describe('StripeProvider', () => {
  it.each([
    ['requires_payment_method', 'requires_payment'],
    ['requires_confirmation', 'requires_payment'],
    ['requires_action', 'requires_payment'],
    ['processing', 'processing'],
    ['requires_capture', 'processing'],
    ['succeeded', 'succeeded'],
    ['canceled', 'canceled'],
  ] as const)('maps %s → %s', (stripeStatus, ours) => {
    expect(mapStripeStatus(stripeStatus)).toBe(ours);
  });

  it('reads refunds from the expanded latest charge', () => {
    const pi = {
      id: 'pi_123',
      status: 'succeeded',
      amount: 5000,
      currency: 'usd',
      latest_charge: { id: 'ch_1', amount_refunded: 5000 },
      last_payment_error: null,
      metadata: { paymentId: 'p1' },
    } as unknown as Parameters<typeof toProviderPayment>[0];
    expect(toProviderPayment(pi)).toEqual({
      id: 'pi_123',
      status: 'succeeded',
      amountCents: 5000,
      currency: 'USD',
      refundedCents: 5000,
      lastError: null,
      metadata: { paymentId: 'p1' },
    });
  });

  it('extracts the payment intent from payment_intent.* and charge.* webhooks', () => {
    const a = signed({
      id: 'evt_a',
      type: 'payment_intent.succeeded',
      data: { object: { object: 'payment_intent', id: 'pi_a' } },
    });
    expect(provider.parseWebhook(a.body, a.headers)).toEqual({
      id: 'evt_a',
      type: 'payment_intent.succeeded',
      providerPaymentId: 'pi_a',
    });

    const b = signed({
      id: 'evt_b',
      type: 'charge.refunded',
      data: { object: { object: 'charge', id: 'ch_b', payment_intent: 'pi_b' } },
    });
    expect(provider.parseWebhook(b.body, b.headers).providerPaymentId).toBe('pi_b');
  });

  it('rejects webhooks without a valid Stripe-Signature', () => {
    const a = signed({ id: 'evt_a', type: 'x', data: { object: {} } });
    expect(() => provider.parseWebhook(a.body, {})).toThrow();
    expect(() => provider.parseWebhook(Buffer.from('{"id":"evt_forged"}'), a.headers)).toThrow();
  });
});
