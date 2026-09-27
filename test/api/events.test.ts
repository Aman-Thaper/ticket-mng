import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/index.js';
import { createEvent, createUser, createVenue, inDays, useApp } from '../helpers.js';

describe('events', () => {
  const t = useApp();
  let ids: { organizerId: string; venueId: string };

  beforeEach(async () => {
    const [organizer, venue] = await Promise.all([createUser(t.app), createVenue(t.app)]);
    ids = { organizerId: organizer.id, venueId: venue.id };
  });

  describe('create', () => {
    it('creates a draft event and a priced seat for every venue seat', async () => {
      const res = await createEvent(t.app, ids);
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        status: 'draft',
        currency: 'USD',
        seats: { total: 14, available: 14 },
        priceRange: { minCents: 4500, maxCents: 8000 },
      });

      const map = await t.app.inject({ url: `/api/v1/events/${res.json().id}/seats` });
      const sections = map.json().sections;
      expect(sections.map((s: { name: string }) => s.name)).toEqual(['Floor', 'Balcony']);
      expect(sections[0].seats[0]).toMatchObject({
        row: 'A',
        number: 1,
        priceCents: 8000,
        status: 'available',
      });
    });

    it('requires every section to be priced exactly once', async () => {
      const res = await createEvent(t.app, ids, {
        pricing: [
          { section: 'Floor', priceCents: 100 },
          { section: 'VIP', priceCents: 100 },
        ],
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toMatchObject({
        code: 'INVALID_PRICING',
        details: { missing: ['Balcony'], unknown: ['VIP'] },
      });
    });

    it('rejects attendees as organizers and unknown venues', async () => {
      const attendee = await createUser(t.app, 'attendee');
      expect((await createEvent(t.app, { ...ids, organizerId: attendee.id })).json().error.code).toBe(
        'NOT_AN_ORGANIZER',
      );
      expect(
        (await createEvent(t.app, { ...ids, venueId: '00000000-0000-4000-8000-000000000000' })).json().error
          .code,
      ).toBe('VENUE_NOT_FOUND');
    });

    it('rejects events in the past or ending before they start', async () => {
      expect((await createEvent(t.app, ids, { startsAt: inDays(-1), endsAt: inDays(1) })).statusCode).toBe(
        400,
      );
      expect((await createEvent(t.app, ids, { startsAt: inDays(2), endsAt: inDays(1) })).statusCode).toBe(
        400,
      );
    });

    it('prevents two overlapping events at the same venue (DB exclusion constraint)', async () => {
      expect((await createEvent(t.app, ids, { startsAt: inDays(3), endsAt: inDays(3, 4) })).statusCode).toBe(
        201,
      );
      const clash = await createEvent(t.app, ids, { startsAt: inDays(3, 2), endsAt: inDays(3, 6) });
      expect(clash.statusCode).toBe(409);
      expect(clash.json().error.code).toBe('VENUE_TIME_CONFLICT');
      // Back-to-back is fine: tstzrange is [start, end), so the ranges only touch.
      expect(
        (await createEvent(t.app, ids, { startsAt: inDays(3, 4), endsAt: inDays(3, 6) })).statusCode,
      ).toBe(201);
    });

    it('holds under concurrency: 20 parallel creates for one slot, exactly one wins', async () => {
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          createEvent(t.app, ids, { startsAt: inDays(5), endsAt: inDays(5, 2) }),
        ),
      );
      const codes = results.map((r) => r.statusCode).sort();
      expect(codes.filter((c) => c === 201)).toHaveLength(1);
      expect(codes.filter((c) => c === 409)).toHaveLength(19);
    });
  });

  describe('status transitions', () => {
    let eventId: string;
    const patch = (payload: object) =>
      t.app.inject({ method: 'PATCH', url: `/api/v1/events/${eventId}`, payload });

    beforeEach(async () => {
      eventId = (await createEvent(t.app, ids)).json().id;
    });

    it('draft → published → cancelled, and cancelled is final', async () => {
      expect((await patch({ status: 'published' })).json().status).toBe('published');

      const back = await patch({ status: 'draft' });
      expect(back.statusCode).toBe(409);
      expect(back.json().error).toMatchObject({
        code: 'INVALID_STATUS_TRANSITION',
        details: { allowed: ['cancelled'] },
      });

      expect((await patch({ status: 'cancelled' })).json().status).toBe('cancelled');
      expect((await patch({ title: 'Edited' })).json().error.code).toBe('EVENT_CANCELLED');
    });

    it('frees the venue slot once an event is cancelled', async () => {
      await patch({ status: 'cancelled' });
      expect((await createEvent(t.app, ids)).statusCode).toBe(201);
    });

    it('validates a new time against the stored one', async () => {
      const res = await patch({ endsAt: inDays(1) }); // stored startsAt is 7 days out
      expect(res.statusCode).toBe(400);
    });

    it('rejects an empty patch', async () => {
      expect((await patch({})).statusCode).toBe(400);
    });

    it('deletes drafts but not published events', async () => {
      const other = (await createEvent(t.app, ids, { startsAt: inDays(20), endsAt: inDays(20, 2) })).json()
        .id;
      await patch({ status: 'published' });
      expect(
        (await t.app.inject({ method: 'DELETE', url: `/api/v1/events/${eventId}` })).json().error.code,
      ).toBe('EVENT_NOT_DRAFT');
      expect((await t.app.inject({ method: 'DELETE', url: `/api/v1/events/${other}` })).statusCode).toBe(204);
      expect((await t.app.inject({ url: `/api/v1/events/${other}` })).statusCode).toBe(404);
    });
  });

  describe('list', () => {
    beforeEach(async () => {
      // 25 published events, one per day, plus one draft that must not show up.
      for (let d = 1; d <= 25; d++) {
        const res = await createEvent(t.app, ids, {
          title: d === 13 ? 'Jazz under the stars' : `Show ${d}`,
          category: d % 2 ? 'concert' : 'comedy',
          startsAt: inDays(d),
          endsAt: inDays(d, 2),
        });
        await t.app.inject({
          method: 'PATCH',
          url: `/api/v1/events/${res.json().id}`,
          payload: { status: 'published' },
        });
      }
      await createEvent(t.app, ids, { startsAt: inDays(40), endsAt: inDays(40, 2) });
    });

    it('walks every page with the cursor without gaps or duplicates', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const url: string = `/api/v1/events?limit=10${cursor ? `&cursor=${cursor}` : ''}`;
        const body = (await t.app.inject({ url })).json();
        seen.push(...body.data.map((e: { id: string }) => e.id));
        cursor = body.page.nextCursor;
        pages++;
      } while (cursor);

      expect(pages).toBe(3);
      expect(seen).toHaveLength(25);
      expect(new Set(seen).size).toBe(25);
    });

    it('returns events ordered by start time', async () => {
      const data = (await t.app.inject({ url: '/api/v1/events?limit=100' })).json().data;
      const starts = data.map((e: { startsAt: string }) => e.startsAt);
      expect(starts).toEqual([...starts].sort());
    });

    it('filters by full-text search, category, city and date range', async () => {
      const get = async (qs: string) =>
        (await t.app.inject({ url: `/api/v1/events?limit=100&${qs}` })).json().data;
      expect((await get('q=jazz')).map((e: { title: string }) => e.title)).toEqual(['Jazz under the stars']);
      expect(await get('category=comedy')).toHaveLength(12);
      expect(await get('city=BERLIN')).toHaveLength(25);
      expect(await get('city=Paris')).toHaveLength(0);
      expect(
        await get(`from=${encodeURIComponent(inDays(10))}&to=${encodeURIComponent(inDays(15))}`),
      ).toHaveLength(5);
      expect(await get('status=draft')).toHaveLength(1);
    });

    it('lists only upcoming events unless an earlier `from` is given', async () => {
      // The API refuses past start times, so insert one directly.
      await db
        .insertInto('events')
        .values({
          ...ids,
          title: 'Last year',
          category: 'concert',
          status: 'published',
          startsAt: new Date(inDays(-30)),
          endsAt: new Date(inDays(-30, 2)),
        })
        .execute();

      const get = async (qs = '') =>
        (await t.app.inject({ url: `/api/v1/events?limit=100${qs}` })).json().data;
      expect(await get()).toHaveLength(25);
      expect(await get(`&from=${encodeURIComponent(inDays(-60))}`)).toHaveLength(26);
    });

    it('rejects a tampered cursor with 400', async () => {
      const res = await t.app.inject({ url: '/api/v1/events?cursor=abc' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_CURSOR');
    });
  });
});
