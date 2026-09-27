import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { redis } from '../lib/redis.js';
import { signWebhookPayload } from '../modules/payments/signature.js';

/*
 * A pretend payment provider, shaped like Stripe: payment intents with a client secret,
 * test card numbers, idempotency keys, refunds, and signed webhooks delivered at least once.
 *
 * It stands in for an external service, so it keeps its own state (in Redis, under
 * "fakegw:") and talks to our app only through signed webhooks, as a real provider would.
 * This lets the whole payment flow run offline, in tests and CI, with no account needed.
 *
 * Test cards (any expiry/CVC):
 *   4242 4242 4242 4242   succeeds
 *   4000 0000 0000 0002   declined
 *   4000 0000 0000 9995   insufficient funds
 *   4000 0000 0000 0077   goes through "processing", then succeeds a moment later
 */

export type IntentStatus = 'requires_payment_method' | 'processing' | 'succeeded' | 'canceled';

export interface FakeIntent {
  id: string;
  object: 'payment_intent';
  amount: number;
  currency: string;
  status: IntentStatus;
  client_secret: string;
  description: string;
  metadata: Record<string, string>;
  amount_refunded: number;
  last_payment_error: { code: string; message: string } | null;
  created: number;
}

export interface FakeEvent {
  id: string;
  object: 'event';
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
}

export class GatewayError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const key = {
  intent: (id: string) => `fakegw:pi:${id}`,
  idempotency: (k: string) => `fakegw:idem:${k}`,
  lock: (id: string) => `fakegw:lock:${id}`,
};
const DAY = 86_400;
const newId = (prefix: string) => `${prefix}_fake_${randomBytes(12).toString('hex')}`;

// ─── webhook delivery ────────────────────────────────────────────────────────────────────

export type Deliverer = (body: string, headers: Record<string, string>) => Promise<number>;

const httpDeliverer: Deliverer = async (body, headers) => {
  const url = config.FAKE_GATEWAY_WEBHOOK_URL ?? `${config.APP_URL}/api/v1/webhooks/fake`;
  const res = await fetch(url, { method: 'POST', body, headers });
  return res.status;
};

let deliver: Deliverer = httpDeliverer;
/** 'async' behaves like a real provider (fire and forget); tests use 'sync' for determinism. */
let deliveryMode: 'async' | 'sync' = 'async';

export function configureDelivery(opts: { deliverer?: Deliverer; mode?: 'async' | 'sync' }) {
  if (opts.deliverer) deliver = opts.deliverer;
  if (opts.mode) deliveryMode = opts.mode;
}

/** Like real providers: retry non-2xx deliveries with backoff, for a while. */
async function deliverWithRetry(event: FakeEvent, delayMs = 0): Promise<void> {
  if (delayMs) await sleep(delayMs);
  const body = JSON.stringify(event);
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const headers = {
        'content-type': 'application/json',
        'fake-signature': signWebhookPayload(body, config.FAKE_GATEWAY_WEBHOOK_SECRET),
      };
      const status = await deliver(body, headers);
      if (status >= 200 && status < 300) return;
      logger.warn({ eventId: event.id, status, attempt }, 'fake gateway: webhook rejected; will retry');
    } catch (err) {
      logger.warn({ err, eventId: event.id, attempt }, 'fake gateway: webhook delivery failed; will retry');
    }
    await sleep(250 * 2 ** attempt);
  }
  logger.error({ eventId: event.id }, 'fake gateway: giving up on webhook');
}

async function emit(type: string, object: Record<string, unknown>): Promise<void> {
  const event: FakeEvent = {
    id: newId('evt'),
    object: 'event',
    type,
    created: Math.floor(Date.now() / 1000),
    data: { object },
  };
  if (deliveryMode === 'sync') return deliverWithRetry(event);
  if (config.FAKE_GATEWAY_CHAOS) {
    // At-least-once and unordered, like the real thing: each event arrives twice, each
    // copy after a random delay, so later events can overtake earlier ones.
    void deliverWithRetry(event, Math.random() * 1500);
    void deliverWithRetry(event, Math.random() * 1500);
    return;
  }
  void deliverWithRetry(event);
}

// ─── intents ─────────────────────────────────────────────────────────────────────────────

async function save(intent: FakeIntent): Promise<void> {
  await redis.set(key.intent(intent.id), JSON.stringify(intent), 'EX', 30 * DAY);
}

export async function getIntent(id: string): Promise<FakeIntent> {
  const raw = await redis.get(key.intent(id));
  if (!raw) throw new GatewayError(404, 'resource_missing', `No such payment_intent: ${id}`);
  return JSON.parse(raw) as FakeIntent;
}

/** Serialize state changes on one intent (a double-clicked "Pay" must not charge twice). */
async function withIntentLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  for (let i = 0; i < 50; i++) {
    if (await redis.set(key.lock(id), '1', 'PX', 5_000, 'NX')) {
      try {
        return await fn();
      } finally {
        await redis.del(key.lock(id));
      }
    }
    await sleep(20);
  }
  throw new GatewayError(409, 'lock_timeout', 'The payment intent is busy; retry');
}

export async function createIntent(
  params: { amount: number; currency: string; description: string; metadata: Record<string, string> },
  idempotencyKey: string,
): Promise<FakeIntent> {
  const id = newId('pi');
  // Idempotency: the first request with this key wins; repeats get the same intent.
  const claimed = await redis.set(key.idempotency(idempotencyKey), id, 'EX', DAY, 'NX');
  if (!claimed) {
    for (let i = 0; i < 50; i++) {
      const existing = await redis.get(key.idempotency(idempotencyKey));
      if (existing && (await redis.exists(key.intent(existing)))) return getIntent(existing);
      await sleep(20);
    }
    throw new GatewayError(
      409,
      'idempotency_conflict',
      'A request with this idempotency key is still in progress',
    );
  }

  const intent: FakeIntent = {
    id,
    object: 'payment_intent',
    amount: params.amount,
    currency: params.currency.toLowerCase(),
    status: 'requires_payment_method',
    client_secret: `${id}_secret_${randomBytes(16).toString('hex')}`,
    description: params.description,
    metadata: params.metadata,
    amount_refunded: 0,
    last_payment_error: null,
    created: Math.floor(Date.now() / 1000),
  };
  await save(intent);
  return intent;
}

const CARD_OUTCOMES: Record<string, 'succeed' | 'decline' | 'insufficient' | 'slow'> = {
  '4242424242424242': 'succeed',
  '4000000000000002': 'decline',
  '4000000000009995': 'insufficient',
  '4000000000000077': 'slow',
};

/** What the browser calls (Stripe.js's confirmCardPayment). */
export async function confirmIntent(
  id: string,
  clientSecret: string,
  cardNumber: string,
): Promise<FakeIntent> {
  const outcome = CARD_OUTCOMES[cardNumber.replace(/\s/g, '')];
  if (!outcome) throw new GatewayError(400, 'invalid_number', 'Unknown test card number');

  const intent = await withIntentLock(id, async () => {
    const current = await getIntent(id);
    if (current.client_secret !== clientSecret)
      throw new GatewayError(401, 'invalid_client_secret', 'Invalid client secret');
    if (current.status !== 'requires_payment_method') {
      throw new GatewayError(409, 'payment_intent_unexpected_state', `This payment is ${current.status}`);
    }
    if (outcome === 'decline' || outcome === 'insufficient') {
      current.last_payment_error =
        outcome === 'decline'
          ? { code: 'card_declined', message: 'Your card was declined.' }
          : { code: 'insufficient_funds', message: 'Your card has insufficient funds.' };
    } else {
      current.status = outcome === 'slow' ? 'processing' : 'succeeded';
      current.last_payment_error = null;
    }
    await save(current);
    return current;
  });

  if (intent.last_payment_error) await emit('payment_intent.payment_failed', { ...intent });
  else if (intent.status === 'processing') {
    await emit('payment_intent.processing', { ...intent });
    const settle = async () => {
      await sleep(deliveryMode === 'sync' ? 0 : 1_000);
      const settled = await withIntentLock(id, async () => {
        const current = await getIntent(id);
        current.status = 'succeeded';
        await save(current);
        return current;
      });
      await emit('payment_intent.succeeded', { ...settled });
    };
    if (deliveryMode === 'sync') await settle();
    else void settle();
  } else await emit('payment_intent.succeeded', { ...intent });
  return intent;
}

export async function cancelIntent(id: string): Promise<FakeIntent> {
  const intent = await withIntentLock(id, async () => {
    const current = await getIntent(id);
    if (current.status !== 'requires_payment_method') {
      throw new GatewayError(409, 'payment_intent_unexpected_state', `This payment is ${current.status}`);
    }
    current.status = 'canceled';
    await save(current);
    return current;
  });
  await emit('payment_intent.canceled', { ...intent });
  return intent;
}

export async function refundIntent(
  id: string,
  amount: number,
  idempotencyKey: string,
): Promise<{ id: string; status: 'succeeded' }> {
  const refundId = newId('re');
  const claimed = await redis.set(key.idempotency(idempotencyKey), refundId, 'EX', DAY, 'NX');
  if (!claimed) return { id: (await redis.get(key.idempotency(idempotencyKey)))!, status: 'succeeded' };

  const intent = await withIntentLock(id, async () => {
    const current = await getIntent(id);
    if (current.status !== 'succeeded')
      throw new GatewayError(409, 'charge_not_refundable', 'Only succeeded payments can be refunded');
    if (current.amount_refunded + amount > current.amount)
      throw new GatewayError(409, 'charge_already_refunded', 'Already refunded');
    current.amount_refunded += amount;
    await save(current);
    return current;
  });
  await emit('charge.refunded', {
    id: newId('ch'),
    object: 'charge',
    payment_intent: intent.id,
    amount: intent.amount,
    amount_refunded: intent.amount_refunded,
  });
  return { id: refundId, status: 'succeeded' };
}
