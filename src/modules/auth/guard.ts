import type { FastifyRequest } from 'fastify';
import type { UserRole } from '../../db/types.js';
import { forbidden, unauthorized } from '../../lib/errors.js';
import { isSessionRevoked } from './sessions.js';
import { verifyAccessToken } from './tokens.js';

export interface AuthUser {
  id: string;
  role: UserRole;
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth hooks below; null for anonymous requests. */
    user: AuthUser | null;
  }
}

async function authenticate(req: FastifyRequest): Promise<AuthUser> {
  const header = req.headers.authorization;
  if (!header) throw unauthorized();

  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    throw unauthorized('INVALID_TOKEN', 'Expected "Authorization: Bearer <access token>"');
  }

  const claims = await verifyAccessToken(token);
  if (await isSessionRevoked(claims.sid)) {
    throw unauthorized('SESSION_REVOKED', 'Session has been revoked; please log in again');
  }
  // Every later log line for this request (including "request completed") names the user.
  req.log = req.log.child({ userId: claims.sub });
  return { id: claims.sub, role: claims.role, sessionId: claims.sid };
}

// These run as onRequest hooks: before the body is even parsed, so unauthenticated
// requests are rejected as cheaply as possible.

export async function requireAuth(req: FastifyRequest): Promise<void> {
  req.user = await authenticate(req);
}

/** Anonymous is fine, but a token that is present must be valid. Never silently downgrade. */
export async function optionalAuth(req: FastifyRequest): Promise<void> {
  if (req.headers.authorization) req.user = await authenticate(req);
}

export function requireRole(...roles: UserRole[]) {
  return async (req: FastifyRequest): Promise<void> => {
    req.user = await authenticate(req);
    if (!roles.includes(req.user.role)) throw forbidden();
  };
}

/** The authenticated user, for handlers behind requireAuth/requireRole. */
export function currentUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

/** Organizers manage their own resources; admins manage everything. */
export function canManage(user: AuthUser | null, ownerId: string): boolean {
  return !!user && (user.role === 'admin' || user.id === ownerId);
}

/** OpenAPI security requirement for routes that need a bearer token. */
export const bearerAuth = [{ bearerAuth: [] }];
