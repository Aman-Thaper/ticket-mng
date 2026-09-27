import { describe, expect, it } from 'vitest';
import { createUser, useApp } from '../helpers.js';

describe('users', () => {
  const t = useApp();

  it('returns and updates the current user', async () => {
    const user = await createUser('attendee');
    const me = await t.app.inject({ url: '/api/v1/users/me', headers: user.auth });
    expect(me.json()).toMatchObject({ id: user.id, email: user.email, role: 'attendee' });

    const updated = await t.app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me',
      headers: user.auth,
      payload: { name: 'New Name' },
    });
    expect(updated.json().name).toBe('New Name');
  });

  it('lets only admins read other users', async () => {
    const [admin, attendee] = await Promise.all([createUser('admin'), createUser('attendee')]);
    expect(
      (await t.app.inject({ url: `/api/v1/users/${attendee.id}`, headers: admin.auth })).statusCode,
    ).toBe(200);

    const denied = await t.app.inject({ url: `/api/v1/users/${admin.id}`, headers: attendee.auth });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('FORBIDDEN');

    expect((await t.app.inject({ url: `/api/v1/users/${admin.id}` })).statusCode).toBe(401);
  });

  it("changes roles (admin) and revokes the user's sessions so it applies at once", async () => {
    const [admin, user] = await Promise.all([createUser('admin'), createUser('attendee')]);
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${user.id}/role`,
      headers: admin.auth,
      payload: { role: 'organizer' },
    });
    expect(res.json().role).toBe('organizer');
    // The old token still says "attendee", so it must stop working.
    expect((await t.app.inject({ url: '/api/v1/users/me', headers: user.auth })).statusCode).toBe(401);

    const self = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${admin.id}/role`,
      headers: admin.auth,
      payload: { role: 'attendee' },
    });
    expect(self.json().error.code).toBe('CANNOT_CHANGE_OWN_ROLE');
  });

  it('returns 400 for a malformed id and 404 for an unknown one', async () => {
    const admin = await createUser('admin');
    expect((await t.app.inject({ url: '/api/v1/users/not-a-uuid', headers: admin.auth })).statusCode).toBe(
      400,
    );
    const res = await t.app.inject({
      url: '/api/v1/users/00000000-0000-4000-8000-000000000000',
      headers: admin.auth,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'User not found' } });
  });

  it('returns a stable error code for malformed JSON', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{oops',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_REQUEST');
  });

  it('returns a consistent error for unknown routes', async () => {
    const res = await t.app.inject({ url: '/api/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('ROUTE_NOT_FOUND');
  });
});
