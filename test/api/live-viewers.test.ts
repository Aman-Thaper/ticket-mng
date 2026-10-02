import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { buildApp } from '../../src/app.js';
import { ViewerCounts, viewerTotals } from '../../src/realtime/viewers.js';
import {
  createEvent,
  createUser,
  createVenue,
  inDays,
  payFor,
  publish,
  runQueuedJobs,
  useApp,
  type TestUser,
} from '../helpers.js';

interface LiveMessage {
  type: string;
  count?: number;
}

/** A live seat-map connection, with its messages queued so a test can await the next match. */
async function watch(app: FastifyInstance, eventId: string) {
  const ws: WebSocket = await app.injectWS(`/api/v1/events/${eventId}/live`);
  const queue: LiveMessage[] = [];
  const waiters: Array<{ match: (m: LiveMessage) => boolean; resolve: (m: LiveMessage) => void }> = [];
  ws.on('message', (raw: Buffer) => {
    const message = JSON.parse(raw.toString()) as LiveMessage;
    const i = waiters.findIndex((w) => w.match(message));
    if (i >= 0) waiters.splice(i, 1)[0]!.resolve(message);
    else queue.push(message);
  });
  const next = (match: (m: LiveMessage) => boolean) =>
    new Promise<LiveMessage>((resolve, reject) => {
      const i = queue.findIndex(match);
      if (i >= 0) return resolve(queue.splice(i, 1)[0]!);
      const timer = setTimeout(() => reject(new Error('timed out waiting for a live message')), 3_000);
      waiters.push({ match, resolve: (m) => (clearTimeout(timer), resolve(m)) });
    });
  await next((m) => m.type === 'hello');
  return {
    ws,
    /**
     * Resolves once this client is told the total is `count`. Other totals may come first:
     * each hub also reports on its own 5 s timer, which can fire in the middle of a test.
     */
    told: (count: number) => next((m) => m.type === 'viewers' && m.count === count),
    /** Take the viewer totals received and not yet awaited. */
    drain: () => {
      const totals = queue.filter((m) => m.type === 'viewers').map((m) => m.count);
      queue.splice(0, queue.length, ...queue.filter((m) => m.type !== 'viewers'));
      return totals;
    },
    close: () =>
      new Promise<void>((resolve) => {
        if (ws.readyState === ws.CLOSED) return resolve();
        ws.once('close', () => resolve());
        ws.terminate();
      }),
  };
}

/** Let the server process socket closes (they arrive asynchronously). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('live viewers and trending', () => {
  const t = useApp();
  let other: FastifyInstance;
  let organizer: TestUser;
  let venueId: string;
  let eventId: string;

  beforeAll(async () => {
    // A second instance, as if behind the same load balancer: each reports its own clients.
    other = await buildApp({ logger: false });
    await other.ready();
  });
  afterAll(async () => {
    await other.close();
  });

  beforeEach(async () => {
    organizer = await createUser('organizer');
    venueId = (await createVenue(t.app, organizer)).id;
    eventId = (await createEvent(t.app, organizer, venueId)).json().id;
    await publish(t.app, organizer, eventId);
  });

  const newEvent = async (title: string, startsInDays: number) => {
    const id = (
      await createEvent(t.app, organizer, venueId, {
        title,
        startsAt: inDays(startsInDays),
        endsAt: inDays(startsInDays, 3),
      })
    ).json().id;
    await publish(t.app, organizer, id);
    return id as string;
  };

  const live = async (id: string) => (await t.app.inject({ url: `/api/v1/events/${id}` })).json().live;

  it('sums viewers across instances, and tells every client the total', async () => {
    const [a1, a2, b1] = await Promise.all([
      watch(t.app, eventId),
      watch(t.app, eventId),
      watch(other, eventId),
    ]);
    try {
      await t.app.liveHub.reportViewers(); // A reports 2
      await other.liveHub.reportViewers(); // B reports 1, reads 3, tells its client
      await t.app.liveHub.reportViewers(); // A reads 3, tells its clients
      await Promise.all([b1.told(3), a1.told(3), a2.told(3)]);
      expect(await live(eventId)).toEqual({ viewers: 3, soldLastHour: 0 });

      // A newcomer hears the current count right after hello, without waiting for a report.
      const a3 = await watch(t.app, eventId);
      await a3.told(3);
      await a3.close();
    } finally {
      await Promise.all([a1.close(), a2.close(), b1.close()]);
    }
  });

  it('lowers the count at the next report when viewers leave, and only messages on change', async () => {
    const [a1, a2] = await Promise.all([watch(t.app, eventId), watch(t.app, eventId)]);
    try {
      await t.app.liveHub.reportViewers();
      await a1.told(2);
      a1.drain();
      await t.app.liveHub.reportViewers(); // the total hasn't changed: nothing is sent
      await settle();
      expect(a1.drain()).toEqual([]);

      await a2.close();
      await settle();
      await t.app.liveHub.reportViewers();
      await a1.told(1);
    } finally {
      await a1.close();
    }

    // The last viewer on this instance left: its count is withdrawn, not left to expire.
    await settle();
    await t.app.liveHub.reportViewers();
    expect((await viewerTotals([eventId])).get(eventId)).toBe(0);
  });

  it("forgets a crashed instance's count on its own (per-field expiry)", async () => {
    const crashed = new ViewerCounts('crashed-instance', 300);
    const healthy = new ViewerCounts('healthy-instance');
    await crashed.report(new Map([[eventId, 5]]));
    await healthy.report(new Map([[eventId, 2]]));
    expect((await viewerTotals([eventId])).get(eventId)).toBe(7);

    // The crashed instance never reports again. Nobody cleans up after it.
    await new Promise((resolve) => setTimeout(resolve, 450));
    await healthy.report(new Map([[eventId, 2]]));
    expect((await viewerTotals([eventId])).get(eventId)).toBe(2);
  });

  it('withdraws an instance’s counts at once on graceful shutdown', async () => {
    const third = await buildApp({ logger: false });
    await third.ready();
    const viewer = await watch(third, eventId);
    await third.liveHub.reportViewers();
    expect((await viewerTotals([eventId])).get(eventId)).toBe(1);

    await third.close(); // closes the socket with 1001 and withdraws the count
    expect((await viewerTotals([eventId])).get(eventId)).toBe(0);
    await viewer.close();
  });

  it('counts tickets sold in the last hour; a refund takes them back out', async () => {
    const buyer = await createUser('attendee');
    const seats = (await t.app.inject({ url: `/api/v1/events/${eventId}/seats` })).json().sections[0].seats;
    const hold = await t.app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/bookings`,
      headers: buyer.auth,
      payload: { seatIds: [seats[0].id, seats[1].id] },
    });
    expect(await live(eventId)).toEqual({ viewers: 0, soldLastHour: 0 }); // a hold isn't a sale
    await payFor(t.app, buyer, hold.json().id);
    expect((await live(eventId)).soldLastHour).toBe(2);

    const refund = await t.app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${hold.json().id}/refund`,
      headers: buyer.auth,
    });
    expect(refund.statusCode).toBe(202);
    await runQueuedJobs();
    expect((await live(eventId)).soldLastHour).toBe(0);
  });

  it('lists trending events, most viewers first, leaving out events that are no longer on', async () => {
    const quiet = await newEvent('Quiet Recital', 8);
    const busy = await newEvent('Big Final', 9);
    const cancelled = await newEvent('Called Off', 10);

    const watchers = await Promise.all([
      watch(t.app, quiet),
      watch(t.app, busy),
      watch(t.app, busy),
      watch(other, busy),
      watch(t.app, cancelled),
      watch(t.app, cancelled),
      watch(t.app, cancelled),
      watch(t.app, cancelled),
    ]);
    try {
      await t.app.inject({
        method: 'PATCH',
        url: `/api/v1/events/${cancelled}`,
        headers: organizer.auth,
        payload: { status: 'cancelled' },
      });
      await Promise.all([t.app.liveHub.reportViewers(), other.liveHub.reportViewers()]);

      const res = await t.app.inject({ url: '/api/v1/events/trending' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('public, max-age=5');
      const data = res.json().data as Array<{ id: string; title: string; live: object; seats: object }>;
      expect(data.map((e) => [e.title, e.live])).toEqual([
        ['Big Final', { viewers: 3, soldLastHour: 0 }],
        ['Quiet Recital', { viewers: 1, soldLastHour: 0 }],
      ]);
      expect(data[0]!.seats).toEqual({ total: 14, available: 14 });

      const top = await t.app.inject({ url: '/api/v1/events/trending?limit=1' });
      expect(top.json().data.map((e: { id: string }) => e.id)).toEqual([busy]);
    } finally {
      await Promise.all(watchers.map((w) => w.close()));
    }
  });

  it('is empty when nobody is watching anything', async () => {
    const res = await t.app.inject({ url: '/api/v1/events/trending' });
    expect(res.json()).toEqual({ data: [] });
  });
});
