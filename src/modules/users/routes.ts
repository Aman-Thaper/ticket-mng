import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { db } from '../../db/index.js';
import { USER_ROLES, type User } from '../../db/types.js';
import { conflict, notFound } from '../../lib/errors.js';
import { errors, IdParams, Timestamp } from '../../lib/schemas.js';

export const UserDto = z
  .object({
    id: z.uuid(),
    email: z.email(),
    name: z.string(),
    role: z.enum(USER_ROLES),
    createdAt: Timestamp,
  })
  .meta({ id: 'User' });

// Every response goes through an explicit DTO. Once users get a password_hash column,
// it can never leak by accident.
export const toUserDto = (u: User): z.infer<typeof UserDto> => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  createdAt: u.createdAt.toISOString(),
});

const CreateUserBody = z.object({
  email: z.email().max(254),
  name: z.string().trim().min(1).max(100),
  // Admins are never created through the public API.
  role: z.enum(['attendee', 'organizer']).default('attendee'),
});

export const userRoutes: FastifyPluginAsyncZod = async (app) => {
  // TEMPORARY: Phase 2 replaces this with POST /auth/signup (password hashing, tokens).
  app.post(
    '/users',
    {
      schema: {
        tags: ['users'],
        summary: 'Create a user (temporary until auth lands in Phase 2)',
        body: CreateUserBody,
        response: { 201: UserDto, ...errors },
      },
    },
    async (req, reply) => {
      const user = await db
        .insertInto('users')
        .values(req.body)
        .onConflict((oc) => oc.column('email').doNothing())
        .returningAll()
        .executeTakeFirst();
      if (!user) throw conflict('EMAIL_TAKEN', 'A user with this email already exists');

      return reply.status(201).header('location', `/api/v1/users/${user.id}`).send(toUserDto(user));
    },
  );

  app.get(
    '/users/:id',
    {
      schema: {
        tags: ['users'],
        summary: 'Get a user',
        params: IdParams,
        response: { 200: UserDto, ...errors },
      },
    },
    async (req) => {
      const user = await db
        .selectFrom('users')
        .selectAll()
        .where('id', '=', req.params.id)
        .executeTakeFirst();
      if (!user) throw notFound('User');
      return toUserDto(user);
    },
  );
};
