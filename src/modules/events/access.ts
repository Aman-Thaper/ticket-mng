import type { EventStatus } from '../../db/types.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { canManage, type AuthUser } from '../auth/guard.js';

/**
 * Drafts are private to their organizer (and admins). To everyone else a draft doesn't
 * exist: they get 404, not 403, so its existence isn't leaked.
 */
export const isVisible = (event: { status: EventStatus; organizerId: string }, viewer: AuthUser | null) =>
  event.status !== 'draft' || canManage(viewer, event.organizerId);

/** Ownership check for mutations: invisible → 404, visible but not yours → 403. */
export function assertCanManage(event: { status: EventStatus; organizerId: string }, user: AuthUser) {
  if (canManage(user, event.organizerId)) return;
  throw event.status === 'draft' ? notFound('Event') : forbidden('Only the event organizer can do this');
}
