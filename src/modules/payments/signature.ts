import { createHmac, timingSafeEqual } from 'node:crypto';

/*
 * Webhook signatures, Stripe's scheme (the fake gateway uses the same one):
 *
 *   header:  t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *
 * The webhook endpoint is public: anyone can POST "payment succeeded" to it. The HMAC proves
 * the payment provider sent this exact body, because only it and we know the secret.
 *
 *  - Verify the RAW bytes. Re-serialized JSON (different whitespace or key order) has a
 *    different signature, so the route keeps the body as a Buffer (see payments/routes.ts).
 *  - The timestamp is inside the signed data and must be recent, so a captured webhook
 *    can't be replayed later.
 *  - Compare in constant time, so response timing reveals nothing about how many bytes of a
 *    forged signature matched.
 *  - Accept any of several v1 values: during secret rotation the provider signs with both.
 */

export class WebhookSignatureError extends Error {}

export const DEFAULT_TOLERANCE_SECONDS = 300;

export function signWebhookPayload(
  payload: string,
  secret: string,
  timestamp = Math.floor(Date.now() / 1000),
): string {
  const signature = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

export function verifyWebhookSignature(
  payload: Buffer | string,
  header: string | string[] | undefined,
  secret: string,
  { toleranceSeconds = DEFAULT_TOLERANCE_SECONDS, now = Date.now() } = {},
): void {
  if (typeof header !== 'string' || !header) throw new WebhookSignatureError('missing signature header');

  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') timestamp = Number(value);
    else if (key === 'v1' && value) signatures.push(value);
  }
  if (!timestamp || !Number.isInteger(timestamp) || signatures.length === 0) {
    throw new WebhookSignatureError('malformed signature header');
  }
  if (Math.abs(now / 1000 - timestamp) > toleranceSeconds) {
    throw new WebhookSignatureError('timestamp outside the tolerance window (possible replay)');
  }

  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(payload).digest();
  const valid = signatures.some((sig) => {
    const given = Buffer.from(sig, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!valid) throw new WebhookSignatureError('signature mismatch');
}
