# Payments and webhooks

Money is where bugs are most expensive. Open `src/modules/payments/service.ts` and read its top comment alongside this chapter.

## How card payments work (the general idea)

Your server **never sees card numbers**. The flow with any modern provider (Stripe, and the fake gateway here, which copies Stripe's shape):

<div class="diagram">
<svg viewBox="0 0 760 290" xmlns="http://www.w3.org/2000/svg" font-family="DejaVu Sans, sans-serif" font-size="11.5">
  <defs><marker id="f" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#555"/></marker></defs>
  <g font-weight="bold" text-anchor="middle"><text x="70" y="20">Browser</text><text x="270" y="20">API</text><text x="470" y="20">Provider</text><text x="660" y="20">Worker</text></g>
  <g stroke="#bbb" stroke-dasharray="3 3"><line x1="70" y1="28" x2="70" y2="280"/><line x1="270" y1="28" x2="270" y2="280"/><line x1="470" y1="28" x2="470" y2="280"/><line x1="660" y1="28" x2="660" y2="280"/></g>
  <g stroke="#555" marker-end="url(#f)">
    <line x1="70" y1="50" x2="268" y2="50"/><line x1="270" y1="75" x2="468" y2="75"/><line x1="268" y1="100" x2="72" y2="100"/>
    <line x1="70" y1="130" x2="468" y2="130"/><line x1="470" y1="160" x2="272" y2="160"/><line x1="268" y1="185" x2="468" y2="185"/>
    <line x1="270" y1="210" x2="658" y2="210"/><line x1="660" y1="235" x2="472" y2="235"/><line x1="660" y1="262" x2="72" y2="262"/>
  </g>
  <text x="170" y="45" text-anchor="middle">1. POST /bookings/:id/payment</text>
  <text x="370" y="70" text-anchor="middle">2. create payment intent</text>
  <text x="170" y="95" text-anchor="middle">3. client secret</text>
  <text x="270" y="125" text-anchor="middle">4. pay with card (straight to provider)</text>
  <text x="370" y="155" text-anchor="middle">5. signed webhook</text>
  <text x="370" y="180" text-anchor="middle">6. 200 OK (fast)</text>
  <text x="465" y="205" text-anchor="middle">7. job: process-webhook (via outbox)</text>
  <text x="565" y="230" text-anchor="middle">8. what is the CURRENT state?</text>
  <text x="365" y="257" text-anchor="middle">9. confirm booking, issue tickets → later: email with QR codes</text>
</svg>
</div>

1. The browser asks our API to start paying for a pending booking.
2. The API creates a **payment intent** at the provider ("I want to charge 45.00 USD").
3. The API returns the intent's **client secret** to the browser.
4. The browser sends the card details **directly to the provider** with that secret.
5. The provider tells our server what happened by calling our URL: a **webhook**.
6. We answer 200 immediately.
7. A background job processes it.
8. The job asks the provider for the payment's **current** state.
9. If it succeeded: confirm the booking, issue tickets, queue the email.

## One interface, two providers (`providers/`)

```ts
export interface PaymentProvider {
  readonly name: 'fake' | 'stripe';
  createPayment(input: CreatePaymentInput, idempotencyKey: string): Promise<ProviderPayment & { clientSecret: string }>;
  retrievePayment(providerPaymentId: string): Promise<ProviderPayment>;
  refundPayment(providerPaymentId: string, amountCents: number, idempotencyKey: string): Promise<{...}>;
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ProviderEvent;
}
```

`providers/stripe.ts` and `providers/fake.ts` both implement this; `providers/index.ts` picks one based on `PAYMENT_PROVIDER`. The rest of the code never knows which one is used. This is the **adapter pattern**: wrap an external service behind your own small interface, so you can swap it, fake it in tests, and keep its details out of your business logic.

The **fake gateway** (`src/fake-gateway/`) is a pretend Stripe that runs inside the app: payment intents, test cards (`4242 4242 4242 4242` succeeds, `4000 0000 0000 0002` is declined, `...0077` goes through "processing" first), signed webhooks, and a **chaos mode** (`FAKE_GATEWAY_CHAOS=true`) that delivers every webhook twice, late and out of order. That lets the whole payment flow run offline and be tested against the worst real-world behaviour.

## Starting a payment (`startPayment`)

```ts
const { payment, created } = await withTransaction(async (trx) => {
  const booking = await trx.selectFrom('bookings').select([... , sql<boolean>`expires_at <= now()`.as('lapsed')])
    .where('id', '=', bookingId).forUpdate().executeTakeFirst();
  if (!booking || (booking.userId !== user.id && user.role !== 'admin')) throw notFound('Booking');
  if (booking.status !== 'pending') throw conflict('BOOKING_NOT_PENDING', '...');
  if (booking.lapsed) throw conflict('HOLD_EXPIRED', 'The seat hold has expired; please book again');

  const open = await trx.selectFrom('payments').selectAll()
    .where('bookingId', '=', bookingId).where('status', 'in', ['requires_payment', 'processing'])
    .executeTakeFirst();
  if (open) return { payment: open, created: false };        // already paying: return the same one

  const inserted = await trx.insertInto('payments').values({ bookingId, provider: provider.name,
    amountCents: booking.totalCents, currency: booking.currency }).returningAll().executeTakeFirstOrThrow();
  return { payment: inserted, created: true };
});

// Network call OUTSIDE the transaction. Idempotency key = our payment id.
const intent = await provider.createPayment({ ... }, `payment-${payment.id}`);
```

Key ideas:

- **One open payment per booking.** Calling twice returns the same payment, so a double-click can't create two charges.
- **The provider call is outside the transaction** (never hold locks while waiting on the network).
- **Idempotency key to the provider.** If our server crashes after the provider created the intent but before we saved its id, the retry sends the same key and the provider returns the *same* intent instead of creating a second one.

## Receiving webhooks: verify, store once, answer fast (`ingestWebhook`)

The webhook URL (`POST /api/v1/webhooks/:provider`) is public. Anyone could POST "payment succeeded" to it. So:

**1. Verify the signature (`signature.ts`).** The provider signs each webhook: `header = t=<timestamp>,v1=<HMAC-SHA256(secret, "<timestamp>.<raw body>")>`. Only the provider and we know the secret.

```ts
if (Math.abs(now / 1000 - timestamp) > toleranceSeconds) {
  throw new WebhookSignatureError('timestamp outside the tolerance window (possible replay)');
}
const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(payload).digest();
const valid = signatures.some((sig) => {
  const given = Buffer.from(sig, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
});
if (!valid) throw new WebhookSignatureError('signature mismatch');
```

- It verifies the **raw bytes** of the body. If you parsed the JSON and re-serialized it, spacing or key order could change and the signature would not match. That's why the webhook route has its own content parser that keeps the body as a `Buffer`:

```ts
const webhookRoutes: FastifyPluginAsyncZod = async (app) => {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  app.post('/webhooks/:provider', { ... }, async (req) => { ... });
};
```

  (Fastify plugins are *encapsulated*: this parser change affects only routes inside this plugin.)
- The **timestamp** is signed and must be within 5 minutes, so a captured webhook can't be replayed later.
- `timingSafeEqual` compares in **constant time**. A normal `===` stops at the first different character, and an attacker measuring response times could guess a signature byte by byte.

**2. Store it once.** Insert into `webhook_events` whose primary key is `(provider, event_id)`, with `ON CONFLICT DO NOTHING`. A duplicate delivery inserts nothing and is acknowledged and ignored. In the same transaction, `enqueue` a `process-webhook` job.

**3. Answer 200 immediately.** Providers retry if you're slow, so the real work happens in the job.

## Reconciling: don't trust the message, ask for the truth (`reconcilePayment`)

Webhooks arrive **at least once, in any order, sometimes late**. "succeeded" can arrive before "processing". If you acted on each message's content, a late "processing" could overwrite "succeeded". So the job **ignores the webhook's content** and asks the provider for the payment's **current** state:

```ts
const remote = await provider.retrievePayment(providerPaymentId);
// ...find our payment row...
if (remote.status === 'succeeded' && remote.refundedCents >= remote.amountCents)
  return completeRefund(payment.id);

switch (remote.status) {
  case 'succeeded':        return recordSuccess(payment.id);
  case 'processing':       /* mark processing (only if still requires_payment) */
  case 'canceled':         /* mark canceled */
  case 'requires_payment': /* e.g. card declined: store lastError, the buyer can retry */
}
```

However many times and in whatever order webhooks arrive, every run moves our records toward the same final state. That property is called **convergence**, and it's what makes the system robust.

## Recording success, or refunding automatically (`recordSuccess`)

```ts
return await withTransaction(async (trx) => {
  // seats → booking (inside confirmBookingInTx) → payment: the global lock order
  const outcome = await confirmBookingInTx(trx, before.bookingId, { lateAllowed: true });
  const payment = await trx.selectFrom('payments').selectAll().where('id', '=', paymentId)
    .forUpdate().executeTakeFirstOrThrow();
  if (payment.status === 'succeeded' || payment.status === 'refunded') throw new AlreadyRecorded();

  await trx.updateTable('payments').set({ status: 'succeeded', succeededAt: sql`now()`, lastError: null })
    .where('id', '=', paymentId).execute();

  switch (outcome.kind) {
    case 'confirmed':         return { outcome: outcome.late ? 'confirmed_late' : 'confirmed', ... };
    case 'already_confirmed': await createRefund(trx, payment, 'duplicate_payment'); ...
    case 'event_unavailable': await createRefund(trx, payment, 'event_cancelled' or 'hold_expired'); ...
    case 'seats_lost':
    case 'hold_expired':
    case 'not_confirmable':   await createRefund(trx, payment, 'hold_expired'); ...
  }
});
```

The payment is recorded and the booking confirmed in **one transaction**. If the booking can't be fulfilled any more (the hold lapsed and someone else bought the seats, the event was cancelled, or it was already paid by another payment), the same transaction records the money **and creates a refund**, and a job executes it with the provider. The buyer gets an email saying so. Nobody pays for nothing.

`AlreadyRecorded` is a small trick: if two jobs for the same payment race, the second one notices under the lock and **throws to roll back** everything it did, then reports "already recorded".

## Refunds

- `createRefund` inserts a `refunds` row; a partial unique index allows only one live refund per payment, so a second attempt is a no-op. It queues a `refund` job.
- `executeRefund` (the job) calls `provider.refundPayment` with an idempotency key, so a retried job never refunds twice.
- When the provider confirms (again via webhook + reconcile), `completeRefund` marks the payment `refunded`, ends the booking (`endConfirmedBookingInTx`: tickets voided, seats back on sale), and queues a `refund-processed` email.
- Buyers can request a refund (`POST /bookings/:id/refund`) until `REFUND_CUTOFF_HOURS` (24) before the event. Cancelling an event queues `refund-event`, which refunds every paid booking.

## Idempotency keys for clients (`src/lib/idempotency.ts`)

A buyer clicks "Hold seats", the network drops, and the browser doesn't know if it worked. Retrying could create a second booking. The solution, borrowed from Stripe: the client sends an `Idempotency-Key: <random id>` header; the browser reuses the same key when retrying.

```text
first request      → runs; the response is stored under (user, key)
retry, same body   → the stored response is replayed (header Idempotent-Replayed: true)
concurrent retry   → 409 IDEMPOTENCY_REQUEST_IN_PROGRESS, Retry-After: 1
same key, new body → 422 IDEMPOTENCY_KEY_REUSED
request failed     → the key is deleted, so the client may retry for real
```

How it works: the key is **claimed first** by inserting a row with `ON CONFLICT DO NOTHING` (so two concurrent requests can't both run), together with a SHA-256 hash of the method, route, params and body (to detect the same key used for a different request). After the handler succeeds, its status and body are saved on that row. If a process crashed mid-request, its claim can be taken over after 60 seconds.

<div class="tip"><b>Payment lessons you can reuse anywhere you integrate an external system:</b> verify what comes in; store incoming events with a unique key to dedupe; acknowledge fast and process in a job; re-read the source of truth instead of trusting messages; make every step idempotent; and use idempotency keys on every call that moves money.</div>

# Tickets and check-in

## Issuing tickets

When a booking is confirmed, `issueTickets` inserts one `tickets` row per seat, **in the same transaction**. So tickets exist exactly when the booking is confirmed. A partial unique index (`one valid ticket per seat`) makes a second valid ticket for the same seat impossible even if some logic went wrong.

## Signing tickets (`tickets/signing.ts`)

A QR code must be hard to forge. The code encodes a **signed token**:

```text
payload   = version (1 byte) + ticket id (16 bytes) + event id (16 bytes)
signature = Ed25519(payload)
token     = base64url(payload) + "." + base64url(signature)     (~130 characters)
```

```ts
export function signTicket({ ticketId, eventId }: TicketClaims): string {
  const payload = Buffer.concat([Buffer.from([VERSION]), uuidToBytes(ticketId), uuidToBytes(eventId)]);
  const signature = sign(null, payload, privateKey);
  return `${payload.toString('base64url')}.${signature.toString('base64url')}`;
}

export function verifyTicket(token: string): TicketClaims | null {
  const parts = token.trim().split('.');
  if (parts.length !== 2) return null;
  const payload = Buffer.from(parts[0]!, 'base64url');
  const signature = Buffer.from(parts[1]!, 'base64url');
  if (payload.length !== 33 || payload[0] !== VERSION || signature.length !== 64) return null;
  if (!verify(null, payload, publicKey, signature)) return null;
  return { ticketId: bytesToUuid(payload.subarray(1, 17)), eventId: bytesToUuid(payload.subarray(17, 33)) };
}
```

Why these choices (from the comments in the file):

- **A signature instead of just the ticket id**: a fake or mistyped code is rejected without a database lookup, and nobody can create valid tickets by guessing ids.
- **Ed25519 (a public/private key pair) instead of HMAC (one shared secret)**: door scanners only need the **public** key (`GET /tickets/public-key`) to verify tickets, even offline. If scanners held an HMAC secret, anyone who extracted it from a device could forge tickets.
- **Binary UUIDs instead of JSON**: a shorter token makes a smaller QR code that scans more easily.

`qrcode` turns the token into a PNG image, attached to the confirmation email and returned by `GET /bookings/:id/tickets`.

## Check-in: each ticket admits once (`POST /check-in`)

The signature proves a ticket is genuine. Whether it has *already been used* is a separate question for the database:

```ts
const admitted = await db
  .updateTable('tickets')
  .set({ checkedInAt: sql`now()`, checkedInBy: user.id })
  .where('id', '=', ticket.id)
  .where('status', '=', 'valid')
  .where('checkedInAt', 'is', null)          // only if never checked in
  .returning('checkedInAt')
  .executeTakeFirst();
if (!admitted) { /* 409 TICKET_VOID or ALREADY_CHECKED_IN */ }
```

This is a **conditional update**, a simple and powerful concurrency tool. Two scanners reading the same QR code at the same moment both run this `UPDATE`, but only one can change `checked_in_at` from `NULL`; the other gets zero rows back and answers "already used". No explicit lock needed: the condition is checked atomically by the database.

# Posters: uploading files

Organizers can upload an event poster. The interesting part is that **the file never passes through the API server**:

1. `POST /events/:id/poster/upload-url` returns a **presigned POST** for S3 (MinIO locally): a URL plus signed form fields that allow exactly one upload, of an image, up to 10 MB, within a few minutes (`content-length-range` condition in `lib/storage.ts`).
2. The browser uploads the file **directly to S3**.
3. `PUT /events/:id/poster { key }` checks the object exists, sets `poster_status = 'processing'`, and queues a `process-poster` job (answers 202 Accepted).
4. The worker's `media.ts` handler downloads the original, checks it's really an image (and not a "decompression bomb" that expands to billions of pixels), and uses **sharp** to create WebP versions 320, 640 and 1280 px wide, uploaded with "cache forever" headers (the key changes with every upload). Then `poster_status = 'ready'`.

```ts
const updated = await db.updateTable('events')
  .set({ posterStatus: 'ready', posterVariants: JSON.stringify(variants), posterError: null })
  .where('id', '=', eventId)
  .where('posterKey', '=', key)        // only if this is still the latest upload
  .executeTakeFirst();
```

Again a conditional update: if the organizer uploaded a newer poster while this job ran, the old result is discarded.

Why so many steps? Uploads are big and slow. Streaming them through the API would tie up the server; resizing images is CPU-heavy and would freeze Node's single event loop for every other request. So the heavy work goes to S3 (storage) and the worker (processing), and a non-image file fails with `UnrecoverableError` (no retries, since retrying won't help).

# Live seat maps (WebSockets)

When someone holds a seat, everyone watching that event should see it change immediately. With three API servers, the viewer might be connected to server 1 while the hold happened on server 3. Here's how the message gets there.

## Step 1: publish after commit (`realtime/seat-updates.ts`)

Every seat mutation uses `RETURNING id, event_id, status, version` and passes the rows to `notifySeatChanges`:

```ts
export function notifySeatChanges(changes: SeatChange[]): void {
  if (!changes.length) return;
  const byEvent = new Map<string, SeatTuple[]>();
  for (const c of changes) {
    const list = byEvent.get(c.eventId) ?? [];
    list.push([c.id, c.status, c.version]);     // compact tuples, not objects
    byEvent.set(c.eventId, list);
  }
  afterCommit(async () => {                      // never announce a change that rolls back
    const pipeline = redis.pipeline();
    for (const [eventId, seats] of byEvent) pipeline.publish(seatChannel(eventId), JSON.stringify(seats));
    await pipeline.exec();
  });
}
```

**Redis pub/sub**: `PUBLISH seats:<eventId> <message>` sends the message to every connection currently subscribed to that channel, on any server.

## Step 2: each server's hub fans out (`realtime/hub.ts`)

Each API server has one `LiveSeatHub`. When a browser opens `GET /api/v1/events/:id/live` as a WebSocket, the route calls `hub.join(eventId, socket)`:

```ts
async join(eventId: string, socket: WebSocket): Promise<boolean> {
  if (this.connections >= MAX_CONNECTIONS) {
    socket.close(1013, 'Server busy; try again');      // 1013 = try again later
    return false;
  }
  // ...track connection, heartbeat and close handler...
  let viewers = this.sockets.get(eventId);
  if (!viewers) {
    viewers = new Set();
    this.sockets.set(eventId, viewers);
    await this.subscriber.subscribe(seatChannel(eventId));   // first viewer of this event here
  }
  viewers.add(socket);
  return true;
}
```

- A server subscribes to an event's channel only while it has viewers for that event.
- A **dedicated Redis connection** is used for subscribing, because a subscribed connection can't run other commands.

When a message arrives, the hub **batches** changes for 100 ms, keeping only the newest version of each seat, then sends one message per event to all its viewers (serialized once, not once per viewer):

```ts
private onMessage(channel: string, message: string) {
  const eventId = channel.slice('seats:'.length);
  if (!this.sockets.has(eventId)) return;
  let buffer = this.pending.get(eventId);
  if (!buffer) this.pending.set(eventId, (buffer = new Map()));
  for (const tuple of JSON.parse(message) as SeatTuple[]) {
    const previous = buffer.get(tuple[0]);
    if (!previous || previous[2] < tuple[2]) buffer.set(tuple[0], tuple);   // newest version wins
  }
  this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_MS);
}
```

Protections built in:

- **Backpressure**: if a slow client has more than 1 MiB of unsent data, it's disconnected (`socket.terminate()`), so one bad phone connection can't eat the server's memory. It will reconnect and reload.
- **Heartbeats**: every 30 s the hub pings each socket; a socket that didn't answer the previous ping is dropped (dead Wi-Fi, sleeping laptops).
- **Connection cap**: 20,000 per server.
- **Graceful shutdown**: on deploy, sockets are closed with code **1001** ("going away"), and the browser reconnects to another server.

## Step 3: the client applies updates by version

The most subtle idea: the browser **subscribes first, then loads the snapshot**, and applies an update only if its `version` is newer than what it has. That handles every tricky case:

- a change that happens between loading the map and subscribing: impossible to miss, because you subscribed first;
- the same update twice, or updates out of order: ignored, because the version isn't newer.

This is the next chapter.
