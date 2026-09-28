import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { buildApp } from '../../src/app.js';
import { db } from '../../src/db/index.js';
import { bumpGenerations, generationKey, MicroCache, readThrough } from '../../src/lib/cache.js';
import { createEvent, createUser, createVenue, publish, useApp, type TestUser } from '../helpers.js';

interface LiveMessage {
  type: string;
  seats?: Array<[number, string, number]>;
}

/** Collect a socket's messages so a test can await the next one that matches. */
function collect(ws: WebSocket) {
  const queue: LiveMessage[] = [];
  const waiters: Array<{ match: (m: LiveMessage) => boolean; resolve: (m: LiveMessage) => void }> = [];
  ws.on('message', (raw: Buffer) => {
    const message = JSON.parse(raw.toString()) as LiveMessage;
    const i = waiters.findIndex((w) => w.match(message));
    if (i >= 0) waiters.splice(i, 1)[0]!.resolve(message);
    else queue.push(message);
  });
  return (match: (m: LiveMessage) => boolean, timeoutMs = 3_000) =>
    new Promise<LiveMessage>((resolve, reject) => {
      const i = queue.findIndex(match);
      if (i >= 0) return resolve(queue.splice(i, 1)[0]!);
      const timer = setTimeout(() => reject(new Error('timed out waiting for a live message')), timeoutMs);
      waiters.push({ match, resolve: (m) => (clearTimeout(timer), resolve(m)) });
    });
}

describe('flash sale machinery', () => {
  const t = useApp();
  let organizer: TestUser;
  let buyer: TestUser;
  let eventId: string;
  let seatIds: number[];

  const hold = (app: FastifyInstance, user: TestUser, seats: number[]) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/bookings`,
      headers: user.auth,
      payload: { seatIds: seats },
    });

  beforeEach(async () => {
    [organizer, buyer] = await Promise.all([createUser('organizer'), createUser('attendee')]);
    const venueId = (await createVenue(t.app, organizer)).id;
    eventId = (await createEvent(t.app, organizer, venueId)).json().id;
    await publish(t.app, organizer, eventId);
    const map = (await t.app.inject({ url: `/api/v1/events/${eventId}/seats` })).json();
    seatIds = map.sections[0].seats.map((s: { id: number }) => s.id);
  });

  describe('live seat updates (WebSocket + Redis pub/sub)', () => {
    let otherInstance: FastifyInstance;

    beforeAll(async () => {
      // A second, independent app instance, as if it were another server behind the load balancer.
      otherInstance = await buildApp({ logger: false });
      await otherInstance.ready();
    });
    afterAll(async () => {
      await otherInstance.close();
    });

    it('says hello once subscribed, then pushes seat changes as [id, status, version]', async () => {
      const ws = await t.app.injectWS(`/api/v1/events/${eventId}/live`);
      const next = collect(ws);
      try {
        await next((m) => m.type === 'hello');
        await hold(t.app, buyer, [seatIds[0]!]);
        const update = await next((m) => m.type === 'seats');
        expect(update.seats).toEqual([[seatIds[0], 'held', 1]]);
      } finally {
        ws.terminate();
      }
    });

    it('fans out across instances: a hold made on instance B reaches a client connected to instance A', async () => {
      const ws = await t.app.injectWS(`/api/v1/events/${eventId}/live`);
      const next = collect(ws);
      try {
        await next((m) => m.type === 'hello');
        expect((await hold(otherInstance, buyer, [seatIds[1]!])).statusCode).toBe(201);
        const update = await next((m) => m.type === 'seats');
        expect(update.seats).toEqual([[seatIds[1], 'held', 1]]);
      } finally {
        ws.terminate();
      }
    });

    it('coalesces changes within the batching window: only the newest state of a seat is sent', async () => {
      const ws = await t.app.injectWS(`/api/v1/events/${eventId}/live`);
      const next = collect(ws);
      try {
        await next((m) => m.type === 'hello');
        const booking = (await hold(t.app, buyer, [seatIds[2]!])).json();
        await t.app.inject({
          method: 'POST',
          url: `/api/v1/bookings/${booking.id}/cancel`,
          headers: buyer.auth,
        });
        const update = await next((m) => m.type === 'seats');
        // Held (v1) then released (v2) within ~100 ms: one message, final state only.
        expect(update.seats).toEqual([[seatIds[2], 'available', 2]]);
      } finally {
        ws.terminate();
      }
    });

    it('refuses unknown and draft events with close code 4404', async () => {
      const draft = (await createEvent(t.app, organizer, (await createVenue(t.app, organizer)).id)).json().id;
      for (const id of [draft, '00000000-0000-4000-8000-000000000000']) {
        const ws = await t.app.injectWS(`/api/v1/events/${id}/live`);
        const code = await new Promise<number>((resolve) => ws.on('close', resolve));
        expect(code).toBe(4404);
      }
    });
  });

  describe('caching', () => {
    it('serves event details from Redis, and a write through the API invalidates them', async () => {
      const first = (await t.app.inject({ url: `/api/v1/events/${eventId}` })).json();
      // Change the row behind the cache's back: the cached copy is (by design) still served...
      await db
        .updateTable('events')
        .set({ title: 'Changed directly in SQL' })
        .where('id', '=', eventId)
        .execute();
      expect((await t.app.inject({ url: `/api/v1/events/${eventId}` })).json().title).toBe(first.title);
      // ...until a write through the API bumps the event's generation.
      await t.app.inject({
        method: 'PATCH',
        url: `/api/v1/events/${eventId}`,
        headers: organizer.auth,
        payload: { description: 'new' },
      });
      expect((await t.app.inject({ url: `/api/v1/events/${eventId}` })).json().title).toBe(
        'Changed directly in SQL',
      );
    });

    it('answers a repeated listing request with 304 Not Modified via ETag', async () => {
      const first = await t.app.inject({ url: '/api/v1/events?limit=5' });
      expect(first.headers.etag).toMatch(/^W\//);
      expect(first.headers['cache-control']).toBe('public, max-age=5');
      const again = await t.app.inject({
        url: '/api/v1/events?limit=5',
        headers: { 'if-none-match': first.headers.etag! },
      });
      expect(again.statusCode).toBe(304);
      expect(again.body).toBe('');
    });

    it('generation counters defeat the slow-reader race', async () => {
      let releaseSlowReader!: () => void;
      const slowRead = readThrough('test', 'race', [generationKey.event('race')], 60, async () => {
        await new Promise<void>((r) => (releaseSlowReader = r));
        return 'stale';
      });
      await new Promise((r) => setTimeout(r, 20));
      await bumpGenerations(generationKey.event('race')); // a writer commits and invalidates
      releaseSlowReader();
      expect((await slowRead).body).toBe('stale'); // the slow reader got its (old) answer...
      // ...but stored it under the old generation, so the next reader loads fresh data.
      const fresh = await readThrough('test', 'race', [generationKey.event('race')], 60, async () => 'fresh');
      expect(fresh.body).toBe('fresh');
    });

    it('micro-cache: 50 concurrent misses share one load (single-flight)', async () => {
      const cache = new MicroCache('test', 1_000);
      let loads = 0;
      const results = await Promise.all(
        Array.from({ length: 50 }, () =>
          cache.get('k', async () => {
            loads++;
            await new Promise((r) => setTimeout(r, 20));
            return 'value';
          }),
        ),
      );
      expect(loads).toBe(1);
      expect(new Set(results.map((r) => r.body))).toEqual(new Set(['value']));
    });
  });

  describe('rate limiting and plumbing', () => {
    it('limits each client IP across the whole API (and exempts provider webhooks)', async () => {
      const app = await buildApp(
        { logger: false },
        { rateLimit: { enabled: true, capacity: 3, refillPerSec: 0.01 } },
      );
      try {
        const codes = [];
        for (let i = 0; i < 4; i++) codes.push((await app.inject({ url: '/api/v1/events' })).statusCode);
        expect(codes).toEqual([200, 200, 200, 429]);
        const limited = await app.inject({ url: '/api/v1/events' });
        expect(limited.headers['retry-after']).toBeDefined();
        expect(limited.headers['ratelimit-limit']).toBe('3');
        // Webhooks bypass it (they fail on the signature instead).
        expect(
          (await app.inject({ method: 'POST', url: '/api/v1/webhooks/fake', payload: '{}' })).statusCode,
        ).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('serves the demo pages with a strict content security policy', async () => {
      const page = await t.app.inject({ url: '/' });
      expect(page.statusCode).toBe(200);
      expect(page.headers['content-type']).toContain('text/html');
      expect(page.headers['content-security-policy']).toContain("script-src 'self'");
      expect((await t.app.inject({ url: '/reset-password.html' })).statusCode).toBe(200);
      expect((await t.app.inject({ url: '/api/v1/nope' })).json().error.code).toBe('ROUTE_NOT_FOUND');
    });

    it('tags every response with the instance that served it', async () => {
      expect((await t.app.inject({ url: '/health' })).headers['x-served-by']).toBeTruthy();
    });

    it('turns database overload into 503 + Retry-After instead of 500', async () => {
      const app = await buildApp({ logger: false });
      app.get('/boom', async () => {
        throw new Error('timeout exceeded when trying to connect');
      });
      try {
        const res = await app.inject({ url: '/boom' });
        expect(res.statusCode).toBe(503);
        expect(res.json().error.code).toBe('SERVICE_BUSY');
        expect(res.headers['retry-after']).toBe('2');
      } finally {
        await app.close();
      }
    });
  });
});
