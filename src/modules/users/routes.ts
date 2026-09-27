import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { db } from '../../db/index.js';
import { USER_ROLES } from '../../db/types.js';
import { notFound, unprocessable } from '../../lib/errors.js';
import { errors, IdParams } from '../../lib/schemas.js';
import { bearerAuth, currentUser, requireAuth, requireRole } from '../auth/guard.js';
import { denylistSessions, revokeSessions } from '../auth/sessions.js';
import { toUserDto, UserDto } from './dto.js';

const userColumns = ['id', 'email', 'name', 'role', 'createdAt'] as const;

export const userRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/users/me',
    {
      onRequest: requireAuth,
      schema: {
        tags: ['users'],
        summary: 'The authenticated user',
        security: bearerAuth,
        response: { 200: UserDto, ...errors },
      },
    },
    async (req) => {
      const user = await db
        .selectFrom('users')
        .select(userColumns)
        .where('id', '=', currentUser(req).id)
        .executeTakeFirst();
      if (!user) throw notFound('User');
      return toUserDto(user);
    },
  );

  app.patch(
    '/users/me',
    {
      onRequest: requireAuth,
      schema: {
        tags: ['users'],
        summary: 'Update your profile',
        security: bearerAuth,
        body: z.object({ name: z.string().trim().min(1).max(100) }),
        response: { 200: UserDto, ...errors },
      },
    },
    async (req) => {
      const user = await db
        .updateTable('users')
        .set({ name: req.body.name })
        .where('id', '=', currentUser(req).id)
        .returning(userColumns)
        .executeTakeFirst();
      if (!user) throw notFound('User');
      return toUserDto(user);
    },
  );

  app.get(
    '/users/:id',
    {
      onRequest: requireRole('admin'),
      schema: {
        tags: ['users'],
        summary: 'Get any user (admin)',
        security: bearerAuth,
        params: IdParams,
        response: { 200: UserDto, ...errors },
      },
    },
    async (req) => {
      const user = await db
        .selectFrom('users')
        .select(userColumns)
        .where('id', '=', req.params.id)
        .executeTakeFirst();
      if (!user) throw notFound('User');
      return toUserDto(user);
    },
  );

  app.patch(
    '/users/:id/role',
    {
      onRequest: requireRole('admin'),
      schema: {
        tags: ['users'],
        summary: "Change a user's role (admin)",
        description:
          "Revokes the user's sessions so the new role applies immediately instead of when their current access token expires.",
        security: bearerAuth,
        params: IdParams,
        body: z.object({ role: z.enum(USER_ROLES) }),
        response: { 200: UserDto, ...errors },
      },
    },
    async (req) => {
      if (req.params.id === currentUser(req).id) {
        throw unprocessable('CANNOT_CHANGE_OWN_ROLE', 'Admins cannot change their own role');
      }

      const result = await db.transaction().execute(async (trx) => {
        const user = await trx
          .updateTable('users')
          .set({ role: req.body.role })
          .where('id', '=', req.params.id)
          .returning(userColumns)
          .executeTakeFirst();
        if (!user) return null;
        return { user, revoked: await revokeSessions(trx, { userId: user.id }, 'role_changed') };
      });
      if (!result) throw notFound('User');

      await denylistSessions(result.revoked);
      return toUserDto(result.user);
    },
  );
};
