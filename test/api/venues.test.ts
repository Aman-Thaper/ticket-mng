import { describe, expect, it } from 'vitest';
import { createVenue, useApp } from '../helpers.js';

describe('venues', () => {
  const t = useApp();

  it('creates a venue with its generated seat layout', async () => {
    const venue = await createVenue(t.app);
    expect(venue.capacity).toBe(2 * 5 + 1 * 4);

    const res = await t.app.inject({ url: `/api/v1/venues/${venue.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().sections).toEqual([
      expect.objectContaining({ name: 'Floor', rows: 2, seats: 10 }),
      expect.objectContaining({ name: 'Balcony', rows: 1, seats: 4 }),
    ]);
  });

  it('validates the body and reports every problem with its path', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/venues',
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
    await createVenue(t.app, { name: 'Royal Albert Hall', city: 'London', country: 'GB' });
    await createVenue(t.app, { name: 'O2 Arena', city: 'London', country: 'GB' });
    await createVenue(t.app, { name: 'Madison Square Garden', city: 'New York', country: 'US' });

    const london = await t.app.inject({ url: '/api/v1/venues?city=london&limit=1' });
    expect(london.json().data).toHaveLength(1);
    expect(london.json().page).toEqual({ limit: 1, offset: 0, total: 2 });

    const search = await t.app.inject({ url: '/api/v1/venues?q=square' });
    expect(search.json().data.map((v: { name: string }) => v.name)).toEqual(['Madison Square Garden']);
  });

  it('treats LIKE wildcards in search literally', async () => {
    await createVenue(t.app, { name: 'Anything' });
    const res = await t.app.inject({ url: '/api/v1/venues?q=%25' }); // q=%
    expect(res.json().data).toHaveLength(0);
  });
});
