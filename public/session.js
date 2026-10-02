// Session handling shared by every page: the API client, token refresh, and redirects.
//
// How a session works here (see src/modules/auth/routes.ts):
//   - the access token (15 minutes) lives only in this module's memory, never in storage;
//   - the refresh token is an httpOnly cookie that JavaScript can't read, sent only to
//     /api/v1/auth; POST /auth/refresh trades it for a fresh access token;
//   - a readable "has_session" cookie says whether a refresh is worth trying, so logged-out
//     visitors don't produce a 401 on every page load.
//
// Tickets saved for offline use (offline-store.js) are deleted on logout, on login, and
// when the server ends the session.

import { clearSavedTickets } from './offline-store.js';

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? `Request failed (HTTP ${status})`);
    this.status = status;
    this.code = body?.error?.code;
    this.details = body?.error?.details;
  }
}

/** offline: the last refresh couldn't reach the server (as opposed to "not logged in"). */
export const session = { token: null, user: null, offline: false };
const listeners = new Set();

/** Call fn(user) whenever the session changes (login, logout, refresh). */
export function onSessionChange(fn) {
  listeners.add(fn);
}

const notify = () => {
  for (const fn of listeners) fn(session.user);
};

function setSession(auth) {
  session.token = auth?.accessToken ?? null;
  session.user = auth?.user ?? null;
  notify();
}

const hasSessionHint = () => document.cookie.split('; ').includes('has_session=1');

let refreshing = null;
/** Trade the refresh cookie for a new access token. Concurrent callers share one request. */
export function refreshSession() {
  refreshing ??= (async () => {
    try {
      const res = await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'same-origin' });
      session.offline = false;
      // The server says this session is over (expired, revoked, logged out elsewhere): its
      // saved tickets go with it. Saved tickets live exactly as long as the session.
      if (res.status === 401) await clearSavedTickets();
      setSession(res.ok ? await res.json() : null);
      return res.ok;
    } catch {
      session.offline = true; // keep whatever we had
      notify();
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** On page load: resume the session if there is one. Resolves to the user, or null. */
export async function restoreSession() {
  if (hasSessionHint()) await refreshSession();
  return session.user;
}

/** responseType 'blob' returns the body as a Blob (a file download) instead of parsed JSON. */
export async function api(
  path,
  { method = 'GET', body, headers = {}, retryAuth = true, responseType = 'json' } = {},
) {
  const res = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(session.token ? { authorization: `Bearer ${session.token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // An expired access token: refresh once and replay the request.
  if (res.status === 401 && retryAuth && session.token && (await refreshSession())) {
    return api(path, { method, body, headers, retryAuth: false, responseType });
  }
  if (res.ok && responseType === 'blob') return res.blob();
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

/** Log in or sign up: both answer with { user, accessToken } and set the refresh cookie. */
export async function authenticate(path, body) {
  const auth = await api(path, { method: 'POST', body, retryAuth: false });
  await clearSavedTickets(); // whoever was here before, their tickets don't stay
  setSession(auth);
  return auth.user;
}

export async function logout() {
  await fetch('/api/v1/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  await clearSavedTickets();
  setSession(null);
}

/** Re-read the profile (e.g. after the email address was confirmed in another tab). */
export async function reloadUser() {
  if (!session.token) return null;
  session.user = await api('/users/me');
  notify();
  return session.user;
}

// ─── redirects ─────────────────────────────────────────────────────────────────────────

/**
 * Where to go after logging in: the ?next= parameter, but only if it's a path on this site.
 * Anything else ("//evil.example", "https://…", "javascript:…") would be an open redirect.
 */
export function nextPath(fallback = '/') {
  const next = new URLSearchParams(location.search).get('next');
  return next && /^\/(?![/\\])/.test(next) ? next : fallback;
}

/** A link to an auth page that brings the user back here afterwards. */
export function withNext(page, next = location.pathname + location.search) {
  return next === '/' ? page : `${page}?next=${encodeURIComponent(next)}`;
}

/** Human-friendly text for an error from api()/authenticate(). */
export function describeError(err) {
  if (err instanceof ApiError) {
    if (err.status === 429) {
      const wait = Number(err.details?.retryAfterSec);
      const minutes = Math.ceil(wait / 60);
      return wait
        ? `Too many attempts. Please wait ${wait < 90 ? `${wait} seconds` : `${minutes} minutes`} and try again.`
        : 'Too many attempts. Please wait a moment and try again.';
    }
    if (err.status >= 500) return 'Something went wrong on our side. Please try again in a moment.';
    return err.message;
  }
  return "Can't reach Ticket MNG. Check your connection and try again.";
}
