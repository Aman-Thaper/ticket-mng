import { beforeEach, describe, expect, it } from 'vitest';
import { createUser, createVenue, useApp, type TestUser } from '../helpers.js';

describe('venues', () => {
  const t = useApp();
  let organizer: TestUser;

  beforeEach(async () => {
    organizer = await createUser('organizer');
  });

  it('creates a venue with its generated seat layout', async () => {
    const venue = await createVenue(t.app, organizer);
    expect(venue.capacity).toBe(2 * 5 + 1 * 4);

    const res = await t.app.inject({ url: `/api/v1/venues/${venue.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().sections).toEqual([
      expect.objectContaining({ name: 'Floor', rows: 2, seats: 10 }),
      expect.objectContaining({ name: 'Balcony', rows: 1, seats: 4 }),
    ]);
  });

  it('stores the time zone that event times are shown in (UTC unless given), and rejects unknown ones', async () => {
    expect((await createVenue(t.app, organizer)).timezone).toBe('UTC');
    const toronto = await createVenue(t.app, organizer, { city: 'Toronto', timezone: 'America/Toronto' });
    expect(toronto.timezone).toBe('America/Toronto');

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/venues',
      headers: organizer.auth,
      payload: {
        name: 'Nowhere Hall',
        address: '1 Main St',
        city: 'Atlantis',
        country: 'US',
        timezone: 'Mars/Olympus_Mons',
        sections: [{ name: 'Floor', rows: 1, seatsPerRow: 1 }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details).toEqual([
      expect.objectContaining({ path: 'body.timezone', message: expect.stringContaining('IANA') }),
    ]);
  });

  it('only lets organizers and admins create venues', async () => {
    const attendee = await createUser('attendee');
    await expect(createVenue(t.app, attendee)).rejects.toThrow(/FORBIDDEN/);
    const anon = await t.app.inject({ method: 'POST', url: '/api/v1/venues', payload: {} });
    expect(anon.statusCode).toBe(401); // auth runs before validation
  });

  it('validates the body and reports every problem with its path', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/venues',
      headers: organizer.auth,
      payload: { name: '', city: 'X', country: 'germany', address: 'a', sections: [] },
    });
    expect(res.statusCode).toBe(400);
    const paths = res.json().error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['body.name', 'body.country', 'body.sections']));
  });

  it('rejects duplicate section names', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/venues',
      headers: organizer.auth,
      payload: {
        name: 'V',
        address: 'a',
        city: 'c',
        country: 'US',
        sections: [
          { name: 'A', rows: 1, seatsPerRow: 1 },
          { name: 'a', rows: 1, seatsPerRow: 1 },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('lists with search, city filter and offset pagination', async () => {
    await createVenue(t.app, organizer, { name: 'Royal Albert Hall', city: 'London', country: 'GB' });
    await createVenue(t.app, organizer, { name: 'O2 Arena', city: 'London', country: 'GB' });
    await createVenue(t.app, organizer, { name: 'Madison Square Garden', city: 'New York', country: 'US' });

    const london = await t.app.inject({ url: '/api/v1/venues?city=london&limit=1' });
    expect(london.json().data).toHaveLength(1);
    expect(london.json().page).toEqual({ limit: 1, offset: 0, total: 2 });

    const search = await t.app.inject({ url: '/api/v1/venues?q=square' });
    expect(search.json().data.map((v: { name: string }) => v.name)).toEqual(['Madison Square Garden']);
  });

  it('treats LIKE wildcards in search literally', async () => {
    await createVenue(t.app, organizer, { name: 'Anything' });
    const res = await t.app.inject({ url: '/api/v1/venues?q=%25' }); // q=%
    expect(res.json().data).toHaveLength(0);
  });
});
