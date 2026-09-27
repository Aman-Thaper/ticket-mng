import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { config } from '../../src/config.js';
import { db } from '../../src/db/index.js';
import { sentMail } from '../../src/lib/mailer.js';
import { useApp } from '../helpers.js';

const PASSWORD = 'correct horse battery';

function refreshCookie(res: LightMyRequestResponse) {
  return res.cookies.find((c) => c.name === 'refresh_token');
}

async function signup(app: FastifyInstance, email = 'ada@example.com', role = 'attendee') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { email, password: PASSWORD, name: 'Ada', role },
  });
  expect(res.statusCode).toBe(201);
  return { body: res.json(), cookie: refreshCookie(res)!.value };
}

const me = (app: FastifyInstance, token: string) =>
  app.inject({ url: '/api/v1/users/me', headers: { authorization: `Bearer ${token}` } });

const refresh = (app: FastifyInstance, cookie: string) =>
  app.inject({ method: 'POST', url: '/api/v1/auth/refresh', cookies: { refresh_token: cookie } });

describe('auth', () => {
  const t = useApp();

  describe('signup and login', () => {
    it('signs up, returns an access token and sets an httpOnly, SameSite=Strict refresh cookie', async () => {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/signup',
        payload: { email: 'Ada@Example.com', password: PASSWORD, name: 'Ada' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        user: { email: 'Ada@Example.com', role: 'attendee' },
        tokenType: 'Bearer',
        expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
      });
      expect(refreshCookie(res)).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/api/v1/auth' });

      const profile = await me(t.app, res.json().accessToken);
      expect(profile.statusCode).toBe(200);
      expect(profile.json().email).toBe('Ada@Example.com');
    });

    it('never returns the password hash, and stores argon2id', async () => {
      const { body } = await signup(t.app);
      expect(JSON.stringify(body)).not.toContain('argon2');
      const row = await db
        .selectFrom('users')
        .select('passwordHash')
        .where('id', '=', body.user.id)
        .executeTakeFirstOrThrow();
      expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    });

    it('rejects duplicate emails (case-insensitive) and self-promotion to admin', async () => {
      await signup(t.app);
      const dup = await t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/signup',
        payload: { email: 'ADA@example.com', password: PASSWORD, name: 'Ada' },
      });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error.code).toBe('EMAIL_TAKEN');

      const admin = await t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/signup',
        payload: { email: 'x@example.com', password: PASSWORD, name: 'X', role: 'admin' },
      });
      expect(admin.statusCode).toBe(400);
    });

    it('rejects short passwords', async () => {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/signup',
        payload: { email: 'x@example.com', password: 'short', name: 'X' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('logs in, and gives the same error for a wrong password and an unknown email', async () => {
      await signup(t.app);
      const ok = await t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'ada@example.com', password: PASSWORD },
      });
      expect(ok.statusCode).toBe(200);
      expect(refreshCookie(ok)).toBeDefined();

      const wrong = await t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'ada@example.com', password: 'wrong password' },
      });
      const unknown = await t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'nobody@example.com', password: 'wrong password' },
      });
      expect(wrong.statusCode).toBe(401);
      expect(unknown.statusCode).toBe(401);
      expect(wrong.json()).toEqual(unknown.json());
    });

    it('rate limits login attempts per account and IP with 429 + Retry-After', async () => {
      await signup(t.app);
      const attempt = () =>
        t.app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email: 'ada@example.com', password: 'nope' },
        });
      for (let i = 0; i < 5; i++) expect((await attempt()).statusCode).toBe(401);

      const blocked = await attempt();
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error.code).toBe('RATE_LIMITED');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    });
  });

  describe('access tokens', () => {
    it('requires a bearer token and explains why it was rejected', async () => {
      const none = await t.app.inject({ url: '/api/v1/users/me' });
      expect(none.statusCode).toBe(401);
      expect(none.headers['www-authenticate']).toContain('Bearer');

      const garbage = await me(t.app, 'not.a.jwt');
      expect(garbage.json().error.code).toBe('INVALID_TOKEN');
    });

    it('rejects expired tokens, tokens signed with another key, and alg=none', async () => {
      const { body } = await signup(t.app);
      const [, payload] = body.accessToken.split('.');
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());

      const secret = new TextEncoder().encode(config.JWT_ACCESS_SECRET);
      const expired = await new SignJWT({ sid: claims.sid, role: claims.role })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(claims.sub)
        .setIssuer('ticket-mng')
        .setAudience('ticket-mng-api')
        .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
        .sign(secret);
      expect((await me(t.app, expired)).json().error.code).toBe('TOKEN_EXPIRED');

      const forged = await new SignJWT({ sid: claims.sid, role: 'admin' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(claims.sub)
        .setIssuer('ticket-mng')
        .setAudience('ticket-mng-api')
        .setExpirationTime('5m')
        .sign(new TextEncoder().encode('an attacker guessed a different secret!!'));
      expect((await me(t.app, forged)).json().error.code).toBe('INVALID_TOKEN');

      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const unsigned = `${header}.${Buffer.from(JSON.stringify({ ...claims, role: 'admin' })).toString('base64url')}.`;
      expect((await me(t.app, unsigned)).statusCode).toBe(401);
    });
  });

  describe('refresh token rotation', () => {
    it('issues a new access token and a new refresh cookie', async () => {
      const { cookie } = await signup(t.app);
      const res = await refresh(t.app, cookie);
      expect(res.statusCode).toBe(200);
      const next = refreshCookie(res)!.value;
      expect(next).not.toBe(cookie);
      expect((await me(t.app, res.json().accessToken)).statusCode).toBe(200);
      expect((await refresh(t.app, next)).statusCode).toBe(200);
    });

    it('tolerates a concurrent double refresh (two tabs) within the leeway window', async () => {
      const { cookie } = await signup(t.app);
      const [a, b] = await Promise.all([refresh(t.app, cookie), refresh(t.app, cookie)]);
      expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    });

    it('detects reuse of an old refresh token: revokes the session and its access tokens', async () => {
      const { body, cookie } = await signup(t.app);
      const rotated = await refresh(t.app, cookie);
      const legitCookie = refreshCookie(rotated)!.value;

      // Pretend the rotation happened a minute ago, beyond the benign-race leeway.
      await db
        .updateTable('refreshTokens')
        .set({ usedAt: new Date(Date.now() - 60_000) })
        .where('usedAt', 'is not', null)
        .execute();

      const replay = await refresh(t.app, cookie); // the attacker's stolen copy
      expect(replay.statusCode).toBe(401);
      expect(replay.json().error.code).toBe('REFRESH_TOKEN_REUSED');

      // The whole session is dead: the legitimate holder's newer token and all access tokens.
      expect((await refresh(t.app, legitCookie)).json().error.code).toBe('SESSION_REVOKED');
      expect((await me(t.app, body.accessToken)).json().error.code).toBe('SESSION_REVOKED');
    });

    it('rejects expired refresh tokens and missing cookies', async () => {
      const { cookie } = await signup(t.app);
      await db
        .updateTable('refreshTokens')
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .execute();
      expect((await refresh(t.app, cookie)).json().error.code).toBe('REFRESH_TOKEN_EXPIRED');
      expect((await t.app.inject({ method: 'POST', url: '/api/v1/auth/refresh' })).json().error.code).toBe(
        'MISSING_REFRESH_TOKEN',
      );
    });
  });

  describe('logout and sessions', () => {
    it('logout revokes the session immediately, including its unexpired access token', async () => {
      const { body, cookie } = await signup(t.app);
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        cookies: { refresh_token: cookie },
      });
      expect(res.statusCode).toBe(204);
      expect(refreshCookie(res)?.value).toBe(''); // cleared

      expect((await refresh(t.app, cookie)).json().error.code).toBe('SESSION_REVOKED');
      expect((await me(t.app, body.accessToken)).json().error.code).toBe('SESSION_REVOKED');
    });

    it('lists sessions, revokes one, and logs out everywhere', async () => {
      const first = await signup(t.app);
      const login = () =>
        t.app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email: 'ada@example.com', password: PASSWORD },
        });
      const second = (await login()).json();
      const third = (await login()).json();

      const auth = { authorization: `Bearer ${third.accessToken}` };
      const sessions = (await t.app.inject({ url: '/api/v1/auth/sessions', headers: auth })).json();
      expect(sessions).toHaveLength(3);
      expect(sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);

      const secondSid = JSON.parse(Buffer.from(second.accessToken.split('.')[1], 'base64url').toString()).sid;
      expect(
        (await t.app.inject({ method: 'DELETE', url: `/api/v1/auth/sessions/${secondSid}`, headers: auth }))
          .statusCode,
      ).toBe(204);
      expect((await me(t.app, second.accessToken)).statusCode).toBe(401);
      expect((await me(t.app, first.body.accessToken)).statusCode).toBe(200);

      expect(
        (await t.app.inject({ method: 'POST', url: '/api/v1/auth/logout-all', headers: auth })).statusCode,
      ).toBe(204);
      expect((await me(t.app, first.body.accessToken)).statusCode).toBe(401);
      expect((await me(t.app, third.accessToken)).statusCode).toBe(401);
    });
  });

  describe('passwords', () => {
    it('changing the password keeps this session and revokes the others', async () => {
      const other = await signup(t.app);
      const current = (
        await t.app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email: 'ada@example.com', password: PASSWORD },
        })
      ).json();
      const auth = { authorization: `Bearer ${current.accessToken}` };

      const wrong = await t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/password/change',
        headers: auth,
        payload: { currentPassword: 'nope', newPassword: 'a brand new password' },
      });
      expect(wrong.json().error.code).toBe('INVALID_CURRENT_PASSWORD');

      const res = await t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/password/change',
        headers: auth,
        payload: { currentPassword: PASSWORD, newPassword: 'a brand new password' },
      });
      expect(res.statusCode).toBe(204);
      expect((await me(t.app, current.accessToken)).statusCode).toBe(200);
      expect((await me(t.app, other.body.accessToken)).statusCode).toBe(401);
    });

    it('resets a password via an emailed, single-use token and logs out every session', async () => {
      const { body } = await signup(t.app);
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/password-reset/request',
        payload: { email: 'ada@example.com' },
      });
      expect(res.statusCode).toBe(202);

      await expect.poll(() => sentMail.length).toBe(1);
      const token = /#token=([\w-]+)/.exec(sentMail[0]!.text)![1]!;
      expect(sentMail[0]!.to).toBe('ada@example.com');

      const confirm = (newPassword: string) =>
        t.app.inject({
          method: 'POST',
          url: '/api/v1/auth/password-reset/confirm',
          payload: { token, newPassword },
        });
      expect((await confirm('my new password')).statusCode).toBe(204);
      expect((await confirm('again another one')).json().error.code).toBe('INVALID_RESET_TOKEN');

      expect((await me(t.app, body.accessToken)).statusCode).toBe(401);
      const login = await t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'ada@example.com', password: 'my new password' },
      });
      expect(login.statusCode).toBe(200);
    });

    it('answers 202 for unknown emails too, without sending anything', async () => {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/password-reset/request',
        payload: { email: 'nobody@example.com' },
      });
      expect(res.statusCode).toBe(202);
      expect(sentMail).toHaveLength(0);
    });

    it('rejects expired reset tokens', async () => {
      await signup(t.app);
      await t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/password-reset/request',
        payload: { email: 'ada@example.com' },
      });
      await expect.poll(() => sentMail.length).toBe(1);
      const token = /#token=([\w-]+)/.exec(sentMail[0]!.text)![1]!;
      await db
        .updateTable('passwordResetTokens')
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .execute();

      const res = await t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/password-reset/confirm',
        payload: { token, newPassword: 'my new password' },
      });
      expect(res.json().error.code).toBe('INVALID_RESET_TOKEN');
    });
  });
});
