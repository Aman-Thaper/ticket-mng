import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/index.js';
import { bumpGenerations, generationKey } from '../../src/lib/cache.js';
import { createEvent, createUser, createVenue, inDays, publish, useApp, type TestUser } from '../helpers.js';

describe('events', () => {
  const t = useApp();
  let organizer: TestUser;
  let venueId: string;

  beforeEach(async () => {
    organizer = await createUser('organizer');
    venueId = (await createVenue(t.app, organizer)).id;
  });

  describe('create', () => {
    it('creates a draft owned by the caller, with a priced seat for every venue seat', async () => {
      const res = await createEvent(t.app, organizer, venueId);
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        organizerId: organizer.id,
        status: 'draft',
        currency: 'USD',
        seats: { total: 14, available: 14 },
        priceRange: { minCents: 4500, maxCents: 8000 },
      });

      const map = await t.app.inject({
        url: `/api/v1/events/${res.json().id}/seats`,
        headers: organizer.auth,
      });
      const sections = map.json().sections;
      expect(sections.map((s: { name: string }) => s.name)).toEqual(['Floor', 'Balcony']);
      expect(sections[0].seats[0]).toMatchObject({
        row: 'A',
        number: 1,
        priceCents: 8000,
        status: 'available',
      });
    });

    it('requires an organizer or admin', async () => {
      const attendee = await createUser('attendee');
      const res = await createEvent(t.app, attendee, venueId);
      expect(res.statusCode).toBe(403);
      expect((await t.app.inject({ method: 'POST', url: '/api/v1/events', payload: {} })).statusCode).toBe(
        401,
      );
    });

    it('requires every section to be priced exactly once', async () => {
      const res = await createEvent(t.app, organizer, venueId, {
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

    it('rejects unknown venues', async () => {
      const res = await createEvent(t.app, organizer, '00000000-0000-4000-8000-000000000000');
      expect(res.json().error.code).toBe('VENUE_NOT_FOUND');
    });

    it('rejects events in the past or ending before they start', async () => {
      expect(
        (await createEvent(t.app, organizer, venueId, { startsAt: inDays(-1), endsAt: inDays(1) }))
          .statusCode,
      ).toBe(400);
      expect(
        (await createEvent(t.app, organizer, venueId, { startsAt: inDays(2), endsAt: inDays(1) })).statusCode,
      ).toBe(400);
    });

    it('prevents two overlapping events at the same venue (DB exclusion constraint)', async () => {
      const slot = (start: number, end: number) => ({ startsAt: inDays(3, start), endsAt: inDays(3, end) });
      expect((await createEvent(t.app, organizer, venueId, slot(0, 4))).statusCode).toBe(201);
      const clash = await createEvent(t.app, organizer, venueId, slot(2, 6));
      expect(clash.statusCode).toBe(409);
      expect(clash.json().error.code).toBe('VENUE_TIME_CONFLICT');
      // Back-to-back is fine: tstzrange is [start, end), so the ranges only touch.
      expect((await createEvent(t.app, organizer, venueId, slot(4, 6))).statusCode).toBe(201);
    });

    it('holds under concurrency: 20 parallel creates for one slot, exactly one wins', async () => {
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          createEvent(t.app, organizer, venueId, { startsAt: inDays(5), endsAt: inDays(5, 2) }),
        ),
      );
      const codes = results.map((r) => r.statusCode);
      expect(
        codes.filter((c) => c === 201),
        `status codes: ${codes.join(',')}`,
      ).toHaveLength(1);
      expect(
        codes.filter((c) => c === 409),
        `status codes: ${codes.join(',')}`,
      ).toHaveLength(19);
    });
  });

  describe('ownership and visibility', () => {
    let eventId: string;
    let other: TestUser;

    beforeEach(async () => {
      eventId = (await createEvent(t.app, organizer, venueId)).json().id;
      other = await createUser('organizer');
    });

    it('hides drafts from everyone but the owner and admins (404, not 403)', async () => {
      const admin = await createUser('admin');
      expect((await t.app.inject({ url: `/api/v1/events/${eventId}` })).statusCode).toBe(404);
      expect((await t.app.inject({ url: `/api/v1/events/${eventId}`, headers: other.auth })).statusCode).toBe(
        404,
      );
      expect((await t.app.inject({ url: `/api/v1/events/${eventId}/seats` })).statusCode).toBe(404);
      expect(
        (await t.app.inject({ url: `/api/v1/events/${eventId}`, headers: organizer.auth })).statusCode,
      ).toBe(200);
      expect((await t.app.inject({ url: `/api/v1/events/${eventId}`, headers: admin.auth })).statusCode).toBe(
        200,
      );
    });

    it('lets other organizers see but not edit a published event, and admins edit anything', async () => {
      await publish(t.app, organizer, eventId);
      expect((await t.app.inject({ url: `/api/v1/events/${eventId}` })).statusCode).toBe(200);

      const edit = (user: TestUser) =>
        t.app.inject({
          method: 'PATCH',
          url: `/api/v1/events/${eventId}`,
          headers: user.auth,
          payload: { title: 'Mine now' },
        });
      expect((await edit(other)).statusCode).toBe(403);
      expect((await edit(await createUser('admin'))).json().title).toBe('Mine now');
    });

    it("doesn't let another organizer delete a draft (they can't even see it)", async () => {
      const res = await t.app.inject({
        method: 'DELETE',
        url: `/api/v1/events/${eventId}`,
        headers: other.auth,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('status transitions', () => {
    let eventId: string;
    const patch = (payload: object) =>
      t.app.inject({ method: 'PATCH', url: `/api/v1/events/${eventId}`, headers: organizer.auth, payload });

    beforeEach(async () => {
      eventId = (await createEvent(t.app, organizer, venueId)).json().id;
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
      expect((await createEvent(t.app, organizer, venueId)).statusCode).toBe(201);
    });

    it('validates a new time against the stored one', async () => {
      const res = await patch({ endsAt: inDays(1) }); // stored startsAt is 7 days out
      expect(res.statusCode).toBe(400);
    });

    it('rejects an empty patch', async () => {
      expect((await patch({})).statusCode).toBe(400);
    });

    it('deletes drafts but not published events', async () => {
      const other = (
        await createEvent(t.app, organizer, venueId, { startsAt: inDays(20), endsAt: inDays(20, 2) })
      ).json().id;
      await patch({ status: 'published' });
      const del = (id: string) =>
        t.app.inject({ method: 'DELETE', url: `/api/v1/events/${id}`, headers: organizer.auth });
      expect((await del(eventId)).json().error.code).toBe('EVENT_NOT_DRAFT');
      expect((await del(other)).statusCode).toBe(204);
      expect(
        (await t.app.inject({ url: `/api/v1/events/${other}`, headers: organizer.auth })).statusCode,
      ).toBe(404);
    });
  });

  describe('list', () => {
    beforeEach(async () => {
      // 25 published events, one per day, plus one draft that must not show up.
      for (let d = 1; d <= 25; d++) {
        const res = await createEvent(t.app, organizer, venueId, {
          title: d === 13 ? 'Jazz under the stars' : `Show ${d}`,
          category: d % 2 ? 'concert' : 'comedy',
          startsAt: inDays(d),
          endsAt: inDays(d, 2),
        });
        await publish(t.app, organizer, res.json().id);
      }
      await createEvent(t.app, organizer, venueId, { startsAt: inDays(40), endsAt: inDays(40, 2) });
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
    });

    it('shows drafts only to their organizer (and admins)', async () => {
      const drafts = (headers?: object) =>
        t.app.inject({ url: '/api/v1/events?status=draft&limit=100', headers: { ...headers } });
      expect((await drafts()).statusCode).toBe(401);
      expect((await drafts((await createUser('attendee')).auth)).statusCode).toBe(403);
      expect((await drafts(organizer.auth)).json().data).toHaveLength(1);
      expect((await drafts((await createUser('organizer')).auth)).json().data).toHaveLength(0);
      expect((await drafts((await createUser('admin')).auth)).json().data).toHaveLength(1);
    });

    it('lists only upcoming events unless an earlier `from` is given', async () => {
      // The API refuses past start times, so insert one directly.
      await db
        .insertInto('events')
        .values({
          organizerId: organizer.id,
          venueId,
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

    it("gives each event its seat counts, price range and venue's time zone", async () => {
      const [first] = (await t.app.inject({ url: '/api/v1/events?limit=1' })).json().data;
      expect(first.seats).toEqual({ total: 14, available: 14 });
      expect(first.priceRange).toEqual({ minCents: 4500, maxCents: 8000 });
      expect(first.venue).toMatchObject({ city: 'Berlin', timezone: 'UTC' });
    });

    it('onSale=true lists only events bookable now: sales open and seats for sale', async () => {
      const onSale = async () =>
        (await t.app.inject({ url: '/api/v1/events?onSale=true&limit=100' })).json().data;
      expect(await onSale()).toHaveLength(25);

      // Sales that haven't opened yet (an event in 20 days, on sale from day 5), and a
      // published event with no seats at all.
      const all = (await t.app.inject({ url: '/api/v1/events?limit=100' })).json().data;
      const [later, empty] = [all[19], all[0]];
      await db
        .updateTable('events')
        .set({ salesStartAt: new Date(inDays(5)) })
        .where('id', '=', later.id)
        .execute();
      await db.deleteFrom('eventSeats').where('eventId', '=', empty.id).execute();
      await bumpGenerations(generationKey.eventLists);

      const ids = (await onSale()).map((e: { id: string }) => e.id);
      expect(ids).toHaveLength(23);
      expect(ids).not.toContain(later.id);
      expect(ids).not.toContain(empty.id);
      // Without the filter, both are still listed (they're published).
      expect((await t.app.inject({ url: '/api/v1/events?limit=100' })).json().data).toHaveLength(25);
    });
  });
});
