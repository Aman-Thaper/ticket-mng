import { describe, expect, it } from 'vitest';
import { useApp } from '../helpers.js';

describe('users', () => {
  const t = useApp();

  it('creates a user and returns 201 with a Location header', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/users',
      payload: { email: 'Ada@Example.com', name: 'Ada' },
    });
    expect(res.statusCode).toBe(201);
    const user = res.json();
    expect(user).toMatchObject({ email: 'Ada@Example.com', name: 'Ada', role: 'attendee' });
    expect(res.headers.location).toBe(`/api/v1/users/${user.id}`);
  });

  it('rejects duplicate emails case-insensitively with 409', async () => {
    const payload = { email: 'grace@example.com', name: 'Grace' };
    await t.app.inject({ method: 'POST', url: '/api/v1/users', payload });
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/users',
      payload: { ...payload, email: 'GRACE@example.com' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('EMAIL_TAKEN');
  });

  it('refuses to create admins through the API', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/users',
      payload: { email: 'x@example.com', name: 'X', role: 'admin' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for a malformed id and 404 for an unknown one', async () => {
    expect((await t.app.inject({ url: '/api/v1/users/not-a-uuid' })).statusCode).toBe(400);
    const res = await t.app.inject({ url: '/api/v1/users/00000000-0000-4000-8000-000000000000' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'User not found' } });
  });

  it('returns a stable error code for malformed JSON', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/users',
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
