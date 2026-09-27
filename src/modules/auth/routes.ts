import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { config } from '../../config.js';
import { db } from '../../db/index.js';
import { AppError, conflict, notFound, unauthorized, unprocessable } from '../../lib/errors.js';
import { enqueue } from '../../jobs/outbox.js';
import { enforce, type RateLimitRule } from '../../lib/rate-limit.js';
import { ErrorResponse, errors, IdParams, Timestamp } from '../../lib/schemas.js';
import { Password, toUserDto, UserDto } from '../users/dto.js';
import { bearerAuth, currentUser, requireAuth } from './guard.js';
import { burnVerifyTime, hashPassword, needsRehash, verifyPassword } from './passwords.js';
import {
  denylistSessions,
  listActiveSessions,
  revokeSessions,
  rotateRefreshToken,
  sessionForRefreshToken,
  startSession,
  type IssuedTokens,
  type SessionMeta,
} from './sessions.js';
import { hashToken } from './tokens.js';

// ---------------------------------------------------------------------------------------
// Refresh token transport: an httpOnly cookie. JavaScript can't read it, so an XSS bug
// can't steal it. SameSite=Strict keeps browsers from attaching it to cross-site requests
// (CSRF). The path scopes it to auth endpoints only, so it isn't sent with every API call.
// The access token travels in the JSON body and is kept in memory by the client.
// ---------------------------------------------------------------------------------------
const REFRESH_COOKIE = 'refresh_token';
const COOKIE_PATH = '/api/v1/auth';

function setRefreshCookie(reply: FastifyReply, tokens: IssuedTokens) {
  reply.setCookie(REFRESH_COOKIE, tokens.refreshToken, {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'strict',
    path: COOKIE_PATH,
    expires: tokens.refreshExpiresAt,
  });
}

function clearRefreshCookie(reply: FastifyReply) {
  reply.clearCookie(REFRESH_COOKIE, {
    path: COOKIE_PATH,
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'strict',
  });
}

const meta = (req: FastifyRequest): SessionMeta => ({ userAgent: req.headers['user-agent'], ip: req.ip });

// Brute-force and abuse protection. Login is limited per IP and per (IP, email): the
// second catches password guessing against one account, while not letting an attacker
// lock a victim out from their own IP.
const LIMITS = {
  loginIp: { name: 'login:ip', capacity: 30, refillPerSec: 30 / 600 },
  loginAccount: { name: 'login:account', capacity: 5, refillPerSec: 5 / 300 },
  signupIp: { name: 'signup:ip', capacity: 10, refillPerSec: 10 / 3600 },
  resetIp: { name: 'reset:ip', capacity: 10, refillPerSec: 10 / 3600 },
  resetEmail: { name: 'reset:email', capacity: 3, refillPerSec: 3 / 3600 },
  passwordChange: { name: 'password-change:user', capacity: 5, refillPerSec: 5 / 900 },
} satisfies Record<string, RateLimitRule>;

const AuthResponse = z
  .object({
    user: UserDto,
    accessToken: z.string(),
    tokenType: z.literal('Bearer'),
    expiresIn: z.int().describe('Access token lifetime in seconds'),
  })
  .meta({ id: 'AuthResponse' });

const authResponse = (user: Parameters<typeof toUserDto>[0], tokens: IssuedTokens) => ({
  user: toUserDto(user),
  accessToken: tokens.accessToken,
  tokenType: 'Bearer' as const,
  expiresIn: tokens.expiresIn,
});

const limited = { 429: ErrorResponse };
const noContent = { 204: z.null().describe('Done') };

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/auth/signup',
    {
      schema: {
        tags: ['auth'],
        summary: 'Create an account and log in',
        description: 'Sets the refresh token as an httpOnly cookie and returns a short-lived access token.',
        body: z.object({
          email: z.email().max(254),
          password: Password,
          name: z.string().trim().min(1).max(100),
          // Admins are never created through the public API.
          role: z.enum(['attendee', 'organizer']).default('attendee'),
        }),
        response: { 201: AuthResponse, ...errors, ...limited },
      },
    },
    async (req, reply) => {
      await enforce(req, reply, [[LIMITS.signupIp, req.ip]]);
      const { password, ...fields } = req.body;
      const passwordHash = await hashPassword(password);

      const result = await db.transaction().execute(async (trx) => {
        const user = await trx
          .insertInto('users')
          .values({ ...fields, passwordHash, passwordChangedAt: new Date() })
          .onConflict((oc) => oc.column('email').doNothing())
          .returningAll()
          .executeTakeFirst();
        if (!user) return null;
        return { user, tokens: await startSession(trx, user, meta(req)) };
      });
      if (!result) throw conflict('EMAIL_TAKEN', 'An account with this email already exists');

      setRefreshCookie(reply, result.tokens);
      return reply.status(201).send(authResponse(result.user, result.tokens));
    },
  );

  app.post(
    '/auth/login',
    {
      schema: {
        tags: ['auth'],
        summary: 'Log in with email and password',
        body: z.object({ email: z.email(), password: z.string().min(1).max(128) }),
        response: { 200: AuthResponse, ...errors, ...limited },
      },
    },
    async (req, reply) => {
      const { email, password } = req.body;
      await enforce(req, reply, [
        [LIMITS.loginIp, req.ip],
        [LIMITS.loginAccount, `${req.ip}:${email.toLowerCase()}`],
      ]);

      const user = await db.selectFrom('users').selectAll().where('email', '=', email).executeTakeFirst();
      const valid = user?.passwordHash
        ? await verifyPassword(user.passwordHash, password)
        : (await burnVerifyTime(password), false);
      // Same error for "no such user" and "wrong password": don't reveal which emails exist.
      if (!user || !valid) throw unauthorized('INVALID_CREDENTIALS', 'Email or password is incorrect');

      if (needsRehash(user.passwordHash!)) {
        await db
          .updateTable('users')
          .set({ passwordHash: await hashPassword(password) })
          .where('id', '=', user.id)
          .execute();
      }

      const tokens = await startSession(db, user, meta(req));
      setRefreshCookie(reply, tokens);
      return authResponse(user, tokens);
    },
  );

  app.post(
    '/auth/refresh',
    {
      schema: {
        tags: ['auth'],
        summary: 'Get a new access token using the refresh-token cookie',
        description:
          'Rotates the refresh token: the cookie is replaced, and the old token becomes invalid. Reusing an old refresh token revokes the whole session (theft detection).',
        response: { 200: AuthResponse, ...errors },
      },
    },
    async (req, reply) => {
      const token = req.cookies[REFRESH_COOKIE];
      if (!token) throw unauthorized('MISSING_REFRESH_TOKEN', 'No refresh token cookie');

      let rotated: Awaited<ReturnType<typeof rotateRefreshToken>>;
      try {
        rotated = await rotateRefreshToken(token);
      } catch (err) {
        clearRefreshCookie(reply);
        throw err;
      }

      const user = await db
        .selectFrom('users')
        .select(['id', 'email', 'name', 'role', 'createdAt'])
        .where('id', '=', rotated.userId)
        .executeTakeFirstOrThrow();
      setRefreshCookie(reply, rotated.tokens);
      return authResponse(user, rotated.tokens);
    },
  );

  app.post(
    '/auth/logout',
    {
      schema: {
        tags: ['auth'],
        summary: 'Log out this session',
        description: 'Revokes the session behind the refresh-token cookie. Always succeeds.',
        response: noContent,
      },
    },
    async (req, reply) => {
      const token = req.cookies[REFRESH_COOKIE];
      const session = token ? await sessionForRefreshToken(token) : undefined;
      if (session) {
        await denylistSessions(
          await revokeSessions(db, { userId: session.userId, sessionId: session.id }, 'logout'),
        );
      }
      clearRefreshCookie(reply);
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/auth/logout-all',
    {
      onRequest: requireAuth,
      schema: {
        tags: ['auth'],
        summary: 'Log out everywhere (revoke every session)',
        security: bearerAuth,
        response: { ...noContent, ...errors },
      },
    },
    async (req, reply) => {
      await denylistSessions(await revokeSessions(db, { userId: currentUser(req).id }, 'logout_all'));
      clearRefreshCookie(reply);
      return reply.status(204).send(null);
    },
  );

  app.get(
    '/auth/sessions',
    {
      onRequest: requireAuth,
      schema: {
        tags: ['auth'],
        summary: 'Your active sessions (devices)',
        security: bearerAuth,
        response: {
          200: z.array(
            z.object({
              id: z.uuid(),
              current: z.boolean(),
              createdAt: Timestamp,
              lastUsedAt: Timestamp,
              userAgent: z.string().nullable(),
              ip: z.string().nullable(),
            }),
          ),
          ...errors,
        },
      },
    },
    async (req) => {
      const user = currentUser(req);
      const sessions = await listActiveSessions(user.id);
      return sessions.map((s) => ({
        id: s.id,
        current: s.id === user.sessionId,
        createdAt: s.createdAt.toISOString(),
        lastUsedAt: s.lastUsedAt.toISOString(),
        userAgent: s.userAgent,
        ip: s.ip,
      }));
    },
  );

  app.delete(
    '/auth/sessions/:id',
    {
      onRequest: requireAuth,
      schema: {
        tags: ['auth'],
        summary: 'Revoke one of your sessions',
        security: bearerAuth,
        params: IdParams,
        response: { ...noContent, ...errors },
      },
    },
    async (req, reply) => {
      const revoked = await revokeSessions(
        db,
        { userId: currentUser(req).id, sessionId: req.params.id },
        'revoked_by_user',
      );
      if (!revoked.length) throw notFound('Session');
      await denylistSessions(revoked);
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/auth/password/change',
    {
      onRequest: requireAuth,
      schema: {
        tags: ['auth'],
        summary: 'Change your password',
        description: 'Revokes every other session; this one stays logged in.',
        security: bearerAuth,
        body: z.object({ currentPassword: z.string().min(1).max(128), newPassword: Password }),
        response: { ...noContent, ...errors, ...limited },
      },
    },
    async (req, reply) => {
      const user = currentUser(req);
      await enforce(req, reply, [[LIMITS.passwordChange, user.id]]);

      const row = await db
        .selectFrom('users')
        .select('passwordHash')
        .where('id', '=', user.id)
        .executeTakeFirstOrThrow();
      if (!row.passwordHash || !(await verifyPassword(row.passwordHash, req.body.currentPassword))) {
        throw unprocessable('INVALID_CURRENT_PASSWORD', 'Current password is incorrect');
      }

      const passwordHash = await hashPassword(req.body.newPassword);
      const revoked = await db.transaction().execute(async (trx) => {
        await trx
          .updateTable('users')
          .set({ passwordHash, passwordChangedAt: new Date() })
          .where('id', '=', user.id)
          .execute();
        return revokeSessions(trx, { userId: user.id, exceptSessionId: user.sessionId }, 'password_changed');
      });
      await denylistSessions(revoked);
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/auth/password-reset/request',
    {
      schema: {
        tags: ['auth'],
        summary: 'Email a password reset link',
        description:
          'Always answers 202, whether or not the email has an account, so it cannot be used to discover accounts.',
        body: z.object({ email: z.email() }),
        response: { 202: z.object({ message: z.string() }), ...errors, ...limited },
      },
    },
    async (req, reply) => {
      const { email } = req.body;
      await enforce(req, reply, [
        [LIMITS.resetIp, req.ip],
        [LIMITS.resetEmail, email.toLowerCase()],
      ]);

      // Don't look the account up here: whether it exists would show in the response time.
      // A worker does the lookup, token and email (see jobs/handlers/email.ts).
      await enqueue(db, 'email', 'password-reset', { email });

      return reply
        .status(202)
        .send({ message: 'If an account exists for this email, a reset link is on its way.' });
    },
  );

  app.post(
    '/auth/password-reset/confirm',
    {
      schema: {
        tags: ['auth'],
        summary: 'Set a new password using a reset token',
        description: 'Logs out every session of the account.',
        body: z.object({ token: z.string().min(1).max(200), newPassword: Password }),
        response: { ...noContent, ...errors },
      },
    },
    async (req, reply) => {
      const revoked = await db.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom('passwordResetTokens')
          .select(['userId', 'expiresAt', 'usedAt'])
          .where('tokenHash', '=', hashToken(req.body.token))
          .forUpdate() // two concurrent confirms with the same token: only one wins
          .executeTakeFirst();
        if (!row || row.usedAt || row.expiresAt <= new Date()) return null;

        await trx
          .updateTable('users')
          .set({ passwordHash: await hashPassword(req.body.newPassword), passwordChangedAt: new Date() })
          .where('id', '=', row.userId)
          .execute();
        await trx
          .updateTable('passwordResetTokens')
          .set({ usedAt: new Date() })
          .where('userId', '=', row.userId)
          .where('usedAt', 'is', null)
          .execute();
        return revokeSessions(trx, { userId: row.userId }, 'password_reset');
      });

      if (!revoked)
        throw new AppError(400, 'INVALID_RESET_TOKEN', 'This reset link is invalid, used or expired');
      await denylistSessions(revoked);
      return reply.status(204).send(null);
    },
  );
};
