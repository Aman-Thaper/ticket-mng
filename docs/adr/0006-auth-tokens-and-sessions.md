# 0006. Short-lived access tokens, rotating refresh tokens, server-side sessions

**Status:** accepted

## Context

Auth is written by hand (the brief excludes auth services). It must scale across API replicas without a shared session lookup on every request, yet support logout, "log out everywhere", password changes and role changes taking effect quickly, and it must survive token theft as well as possible.

## Decision

- **Passwords:** Argon2id, rehashed on login when parameters change; failed logins take the same time whether or not the account exists.
- **Access token:** a JWT (HS256, algorithm pinned, 15-minute lifetime, key rotation through a previous secret) sent as a bearer token. Verifying it needs no database.
- **Refresh token:** random, stored hashed, in an `httpOnly`, `SameSite=Strict` cookie scoped to `/api/v1/auth`. **Rotated on every use**; presenting an already-used token (after a 10-second grace for concurrent tabs) is treated as theft and revokes the whole session.
- **Sessions table:** each login is a session (device, last use), listable and revocable. Revoking also puts the session id on a Redis denylist for the access token's remaining lifetime, so revocation is immediate, not 15 minutes later. The denylist fails open: a Redis outage doesn't lock everyone out.
- **Password reset:** a single-use, 30-minute token, hashed at rest, delivered in the URL _fragment_ (never sent to servers or leaked through `Referer`); the account lookup happens in the worker, so response times can't reveal which emails have accounts.
- **Authorization:** roles (attendee, organizer, admin) plus ownership checks; resources you can't see return 404, not 403, so their existence doesn't leak.

## Consequences

- Stateless request authentication (fast, scales across replicas) with near-immediate revocation.
- A stolen refresh token is detected the moment the legitimate client and the thief both use it.
- Two moving parts (JWT + sessions) to understand, and the denylist's fail-open trade-off.

## Alternatives considered

- **Server-side sessions only:** simple and instantly revocable, but a Redis or database lookup on every request.
- **Long-lived JWTs:** can't be revoked.
- **Refresh tokens in `localStorage`:** readable by any injected script.
