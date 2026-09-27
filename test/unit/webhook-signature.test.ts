import { describe, expect, it } from 'vitest';
import Stripe from 'stripe';
import {
  signWebhookPayload,
  verifyWebhookSignature,
  WebhookSignatureError,
} from '../../src/modules/payments/signature.js';

const secret = 'whsec_test_secret_for_unit_tests';
const payload = JSON.stringify({
  id: 'evt_1',
  type: 'payment_intent.succeeded',
  data: { object: { id: 'pi_1' } },
});

describe('webhook signatures', () => {
  it("verifies headers produced by Stripe's own SDK (same scheme)", () => {
    const stripe = new Stripe('sk_test_unused');
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
    expect(() => verifyWebhookSignature(payload, header, secret)).not.toThrow();
  });

  it('round-trips our own signer', () => {
    expect(() =>
      verifyWebhookSignature(Buffer.from(payload), signWebhookPayload(payload, secret), secret),
    ).not.toThrow();
  });

  it('rejects a body that was modified, even by one byte', () => {
    const header = signWebhookPayload(payload, secret);
    const tampered = payload.replace('succeeded', 'succeedeD');
    expect(() => verifyWebhookSignature(tampered, header, secret)).toThrow(WebhookSignatureError);
  });

  it('rejects the wrong secret', () => {
    const header = signWebhookPayload(payload, 'whsec_some_other_secret');
    expect(() => verifyWebhookSignature(payload, header, secret)).toThrow(/mismatch/);
  });

  it('rejects replays of an old (validly signed) webhook', () => {
    const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
    const header = signWebhookPayload(payload, secret, tenMinutesAgo);
    expect(() => verifyWebhookSignature(payload, header, secret)).toThrow(/tolerance/);
  });

  it('accepts any matching v1 during secret rotation', () => {
    const t = Math.floor(Date.now() / 1000);
    const current = signWebhookPayload(payload, secret, t).split(',')[1]!;
    const old = signWebhookPayload(payload, 'whsec_previous_secret', t).split(',')[1]!;
    expect(() => verifyWebhookSignature(payload, `t=${t},${old},${current}`, secret)).not.toThrow();
  });

  it.each([undefined, '', 'garbage', 'v1=abc', 't=123', 't=abc,v1=00'])(
    'rejects malformed header %j',
    (header) => {
      expect(() => verifyWebhookSignature(payload, header, secret)).toThrow(WebhookSignatureError);
    },
  );
});
