# Authentication: who are you?

**Authentication** = proving who you are (logging in). **Authorization** = deciding what you may do (roles, ownership). The code for both is in `src/modules/auth/`. This project writes auth by hand (no auth service) specifically to learn it.

## The big picture

<div class="diagram">
<svg viewBox="0 0 760 250" xmlns="http://www.w3.org/2000/svg" font-family="DejaVu Sans, sans-serif" font-size="12">
  <defs><marker id="c" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#555"/></marker></defs>
  <rect x="20" y="20" width="160" height="210" rx="8" fill="#e8f0fe" stroke="#4a6fd1"/><text x="100" y="42" text-anchor="middle" font-weight="bold">Browser</text>
  <text x="100" y="70" text-anchor="middle">access token</text><text x="100" y="86" text-anchor="middle" font-size="10.5">(in memory, 15 min)</text>
  <text x="100" y="130" text-anchor="middle">refresh_token cookie</text><text x="100" y="146" text-anchor="middle" font-size="10.5">(httpOnly, 30 days)</text>
  <rect x="580" y="20" width="160" height="210" rx="8" fill="#e6f5ea" stroke="#2e8b57"/><text x="660" y="42" text-anchor="middle" font-weight="bold">API</text>
  <text x="660" y="75" text-anchor="middle" font-size="11">verify signature only</text><text x="660" y="90" text-anchor="middle" font-size="11">(no database needed)</text>
  <text x="660" y="140" text-anchor="middle" font-size="11">sessions + refresh_tokens</text><text x="660" y="155" text-anchor="middle" font-size="11">tables; rotate on use</text>
  <line x1="180" y1="75" x2="578" y2="75" stroke="#555" marker-end="url(#c)"/><text x="380" y="68" text-anchor="middle" font-size="11">every API call: Authorization: Bearer &lt;access token&gt;</text>
  <line x1="180" y1="135" x2="578" y2="135" stroke="#555" marker-end="url(#c)"/><text x="380" y="128" text-anchor="middle" font-size="11">POST /auth/refresh (cookie sent automatically)</text>
  <line x1="578" y1="165" x2="180" y2="165" stroke="#555" marker-end="url(#c)"/><text x="380" y="182" text-anchor="middle" font-size="11">new access token + NEW refresh cookie (old one now used)</text>
</svg>
<div class="caption">Two tokens: a short-lived one for every request, a long-lived one only for getting new short ones.</div>
</div>

## Step 1: storing passwords (`passwords.ts`)

**Never store a password.** Store a *hash*: a one-way scramble. At login, you hash what the user typed and compare. This project uses **Argon2id**, which is deliberately slow and memory-hungry (19 MiB per guess), so an attacker who steals the database can't try billions of passwords per second on GPUs.

```ts
const PARAMS = {
  algorithm: 2 as Algorithm.Argon2id,
  memoryCost: config.ARGON2_MEMORY_KIB,   // 19,456 KiB
  timeCost: config.ARGON2_TIME_COST,      // 2 passes
  parallelism: 1,
};

/** Returns a self-describing string: $argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash> */
export const hashPassword = (password: string) => hash(password, PARAMS);

export async function verifyPassword(phc: string, password: string): Promise<boolean> {
  try {
    return await verify(phc, password);
  } catch {
    return false; // malformed hash: treat as a failed login, never as a crash
  }
}
```

Two clever details:

- `needsRehash(phc)` checks whether a stored hash used older settings. On a successful login (the only moment you know the real password) the app re-hashes with the new settings. So you can make hashing stronger later without forcing everyone to reset.
- `burnVerifyTime(password)`: when the email doesn't exist, the app still spends the same time as a real password check. Otherwise an attacker could measure response times to learn which emails have accounts.

## Step 2: the access token (JWT, `tokens.ts`)

After login, the server gives the client an **access token**, a **JWT** (JSON Web Token). A JWT is three base64 parts: `header.payload.signature`. The payload contains *claims*:

```json
{ "sub": "<user id>", "sid": "<session id>", "role": "attendee", "exp": 1767225600, "iss": "ticket-mng", "aud": "ticket-mng-api" }
```

The signature is an HMAC made with a secret only the server knows (`JWT_ACCESS_SECRET`). So the server can check a token **without looking anything up in the database**: if the signature matches, the server itself issued it and nobody changed it.

```ts
export function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({ sid: claims.sid, role: claims.role })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${config.ACCESS_TOKEN_TTL_SECONDS}s`)   // 15 minutes
    .sign(keys[0]!);
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  for (const key of keys) {
    try {
      const { payload } = await jwtVerify(token, key, {
        algorithms: ['HS256'],       // pinned: the token can't choose how it's verified
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      // ... validate claims with Zod and return them
    } catch (err) {
      if (err instanceof joseErrors.JWSSignatureVerificationFailed) continue; // try previous key
      if (err instanceof joseErrors.JWTExpired) throw unauthorized('TOKEN_EXPIRED', '...');
      break;
    }
  }
  throw unauthorized('INVALID_TOKEN', 'Access token is invalid');
}
```

- `algorithms: ['HS256']` is important. Some JWT libraries used to trust the algorithm written *in the token*, and attackers sent tokens with `"alg": "none"` (no signature). Pinning the algorithm closes that hole.
- `keys` holds the current secret and optionally the previous one, so you can change the secret without logging everyone out (key rotation).

**The problem with JWTs:** once issued, a JWT is valid until it expires; you can't "un-issue" it. That's why it lives only **15 minutes**, and why there is a second token.

## Step 3: sessions and the refresh token (`sessions.ts`)

Each login creates a row in `sessions` (which device, when, from which IP) and a **refresh token**: 32 random bytes. The token is given to the browser in a cookie, and only its **SHA-256 hash** is stored in `refresh_tokens` (so a stolen database can't be used to log in).

```ts
export async function startSession(conn, user, meta): Promise<IssuedTokens> {
  const expiresAt = new Date(Date.now() + config.SESSION_MAX_DAYS * DAY_MS);
  const { id } = await conn
    .insertInto('sessions')
    .values({ userId: user.id, expiresAt, userAgent: meta.userAgent?.slice(0, 300) ?? null, ip: meta.ip ?? null })
    .returning('id')
    .executeTakeFirstOrThrow();
  return issueTokens(user, id, await issueRefreshToken(conn, id, expiresAt));
}
```

When the access token expires, the browser calls `POST /auth/refresh`. The cookie is sent automatically. `rotateRefreshToken`:

1. finds the token row by its hash **and locks it** (`FOR UPDATE`) so two simultaneous refreshes can't both use it;
2. if the session was revoked or expired → 401;
3. **if the token was already used** (more than 10 seconds ago) → someone copied it! The **whole session is revoked**. This is *theft detection*: the thief and the real user end up presenting the same token, and whoever comes second trips the alarm;
4. otherwise marks it used, issues a **new** refresh token (rotation) and a new access token. The role is re-read from the database, so role changes take effect within 15 minutes.

```ts
if (row.usedAt && now - row.usedAt.getTime() > REUSE_LEEWAY_MS) {
  await trx.updateTable('sessions')
    .set({ revokedAt: new Date(), revokeReason: 'refresh_token_reuse' })
    .where('id', '=', row.sessionId)
    .execute();
  return { kind: 'reused', sessionId: row.sessionId } as const;
}
```

Notice it *returns* an outcome instead of throwing inside the transaction. Throwing would roll back the transaction, undoing the revocation it just made.

## Step 4: the cookie (`auth/routes.ts`)

```ts
reply.setCookie(REFRESH_COOKIE, tokens.refreshToken, {
  httpOnly: true,            // JavaScript can't read it → an XSS bug can't steal it
  secure: config.COOKIE_SECURE,  // HTTPS only (in production)
  sameSite: 'strict',        // not sent on requests from other websites → blocks CSRF
  path: '/api/v1/auth',      // only sent to auth endpoints, not with every API call
  expires: tokens.refreshExpiresAt,
});
```

The access token, on the other hand, is returned in the JSON body and kept in a JavaScript variable (memory), not in `localStorage`.

## Step 5: immediate logout (the denylist)

If access tokens need no database lookup, how does logout take effect *now* instead of in 15 minutes? The session id (`sid`) is inside the token. On logout, the app marks the session revoked in Postgres **and** writes `auth:revoked-session:<id>` into Redis for 15 minutes. The guard checks that key on every request.

```ts
export async function isSessionRevoked(sessionId: string): Promise<boolean> {
  try {
    return (await redis.exists(denyKey(sessionId))) === 1;
  } catch (err) {
    logger.error({ err }, 'session denylist unavailable');
    return false;   // fail open: a Redis outage shouldn't lock everyone out
  }
}
```

"Fail open" is a conscious trade-off: if Redis is down, just-revoked tokens keep working up to 15 minutes, rather than *nobody* being able to use the site.

## Step 6: the guard (`guard.ts`)

Routes declare who can call them with `onRequest: requireAuth` or `onRequest: requireRole('organizer', 'admin')`:

```ts
async function authenticate(req: FastifyRequest): Promise<AuthUser> {
  const header = req.headers.authorization;
  if (!header) throw unauthorized();
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) throw unauthorized('INVALID_TOKEN', '...');

  const claims = await verifyAccessToken(token);
  if (await isSessionRevoked(claims.sid)) throw unauthorized('SESSION_REVOKED', '...');
  req.log = req.log.child({ userId: claims.sub });   // later log lines name the user
  return { id: claims.sub, role: claims.role, sessionId: claims.sid };
}

export async function requireAuth(req: FastifyRequest) { req.user = await authenticate(req); }

export function requireRole(...roles: UserRole[]) {
  return async (req: FastifyRequest) => {
    req.user = await authenticate(req);
    if (!roles.includes(req.user.role)) throw forbidden();
  };
}

export function canManage(user: AuthUser | null, ownerId: string): boolean {
  return !!user && (user.role === 'admin' || user.id === ownerId);
}
```

- These run as `onRequest` hooks, **before the body is parsed**, so an unauthenticated flood is rejected cheaply.
- `optionalAuth` is for public routes that show more to logged-in users: no token is fine, but a *bad* token is an error (never silently treat a broken token as anonymous).
- **Roles** answer "what kind of user?". **Ownership** (`canManage`) answers "is this *your* event?". Organizers manage their own events; admins manage everything.
- **404 instead of 403 for hidden things.** In `events/access.ts`, a draft event you don't own returns 404 "not found", not 403 "forbidden", so outsiders can't even learn it exists.

## Other auth features worth reading

- **Rate limits on login** (`LIMITS` in `auth/routes.ts`): per IP, and per IP+email, so password guessing is slowed without letting an attacker lock a victim out.
- **Same error for unknown email and wrong password** (`INVALID_CREDENTIALS`), so the API doesn't reveal which emails are registered.
- **Password reset**: `POST /auth/password-reset/request` always answers 202 and does *nothing visible*; it queues a job, and the **worker** looks up the account and emails a single-use, 30-minute token. Doing the lookup in the worker means response time can't reveal whether the account exists. The link carries the token in the URL *fragment* (`#token=...`), which browsers never send to servers.
- **Password change / role change / reset** revoke sessions so the change takes effect everywhere.

# Venues and events

## Creating a venue and generating seats

An organizer sends a compact description:

```json
{ "name": "City Hall", "address": "1 Main St", "city": "Springfield", "country": "US",
  "sections": [ { "name": "Floor", "rows": 20, "seatsPerRow": 30 },
                { "name": "Balcony", "rows": 8, "seatsPerRow": 40 } ] }
```

`venues/layout.ts` turns that into individual seats with coordinates for drawing. Row labels go A, B, ... Z, AA, AB like spreadsheet columns:

```ts
export function rowLabel(index: number): string {
  let label = '';
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;   // 65 is 'A'
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

export function generateSeats(sections: SectionSpec[]): GeneratedSeat[] {
  const maxWidth = Math.max(...sections.map((s) => s.seatsPerRow));
  const seats: GeneratedSeat[] = [];
  let y = 0;
  for (const section of sections) {
    const xOffset = Math.floor((maxWidth - section.seatsPerRow) / 2);   // centre narrower sections
    for (let r = 0; r < section.rows; r++) {
      const label = rowLabel(r);
      for (let n = 1; n <= section.seatsPerRow; n++) {
        seats.push({ section: section.name, rowLabel: label, seatNumber: n, x: xOffset + n - 1, y });
      }
      y++;
    }
    y += SECTION_GAP;                                    // empty rows between sections
  }
  return seats;
}
```

This is a **pure function** (input → output, no database, no network), which is why it has simple unit tests in `test/unit/layout.test.ts`. The route then saves the venue, its sections and all seats in one transaction, using the `unnest` bulk insert shown in chapter 7.

## Creating an event (`events/routes.ts`)

`POST /events` receives the venue id, times, and a price per section. The handler:

1. checks every venue section is priced exactly once (otherwise 422 `INVALID_PRICING`);
2. in a transaction: **locks the venue row** (`lockVenueSchedule`), inserts the event as a **draft**, and copies all venue seats into `event_seats` with their section's price, in one SQL statement:

```ts
await sql`
  INSERT INTO event_seats (event_id, venue_seat_id, price_cents)
  SELECT ${id}::uuid, vs.id, p.price_cents
  FROM venue_seats vs
  JOIN venue_sections sec ON sec.id = vs.section_id
  JOIN unnest(${pricing.map((p) => p.section)}::text[], ${pricing.map((p) => p.priceCents)}::int[])
    AS p(section_name, price_cents) ON p.section_name = sec.name
  WHERE sec.venue_id = ${venueId}::uuid
`.execute(trx);
```

3. if the overlap constraint fires (error `23P01`), it becomes a friendly 409 `VENUE_TIME_CONFLICT`.

**Why lock the venue row first?** The comment in the code explains a real bug they hit: two simultaneous inserts for overlapping times could each wait for the other inside the exclusion-constraint check (a deadlock that Postgres only breaks after 1 second). Locking the venue row makes them queue up instead, and the second one fails fast and cleanly. This is a good example of a problem you only find by testing concurrency ("20 parallel creates for one slot, exactly one wins" in `test/api/events.test.ts`).

## Event status: a small state machine

```ts
export const STATUS_TRANSITIONS: Record<EventStatus, readonly EventStatus[]> = {
  draft: ['published', 'cancelled'],
  published: ['cancelled'],
  cancelled: [],
};
```

`PATCH /events/:id` locks the event row (`FOR UPDATE`) so two concurrent edits can't both read "draft" and apply conflicting changes, then checks the transition is allowed. Cancelling an event also cancels all pending holds and queues a `refund-event` job that refunds every paid booking.

<div class="tip"><b>Pattern: explicit state machines.</b> Whenever something has a status (orders, bookings, payments, tickets), write down which transitions are allowed, as data, and check them. It prevents impossible states like "cancelled, then published again".</div>

## Listing and searching events: cursor pagination

`GET /events?q=rock&city=Berlin&limit=20` searches with Postgres full-text search (`e.search @@ websearch_to_tsquery('english', q)`) and returns pages.

There are two ways to paginate:

- **Offset** ("skip 100, take 20"): simple, used for venues. But `OFFSET 100000` makes the database read and discard 100,000 rows, and if rows are added between pages, items shift and repeat.
- **Keyset / cursor** ("give me 20 events that come *after* the last one I saw"): used for events. It uses the index to jump straight there, so page 5,000 costs the same as page 1.

```ts
if (cursor) {
  const c = decodeCursor(cursor);
  query = query.where(sql<boolean>`(e.starts_at, e.id) > (${c.at}::timestamptz, ${c.id}::uuid)`);
}
const rows = await query.orderBy('e.startsAt').orderBy('e.id').limit(limit + 1).execute();

const hasMore = rows.length > limit;           // fetched one extra: is there a next page?
const page = hasMore ? rows.slice(0, limit) : rows;
const last = page.at(-1);
return {
  data: page.map(toEventDto),
  page: { limit, nextCursor: hasMore && last ? encodeCursor({ at: last.startsAt, id: last.id }) : null },
};
```

- Sorting by `(starts_at, id)` makes the order total (the id breaks ties between events at the same time), so nothing is skipped.
- Asking for `limit + 1` rows is a neat trick to know whether another page exists without a second `COUNT` query.
- The cursor (in `lib/pagination.ts`) is just `{t, id}` as JSON, base64url-encoded, so clients treat it as an opaque string.

## Reading an event and its seat map

`GET /events/:id` returns the event plus live availability and a price range. `GET /events/:id/seats` returns every seat with position, price, status and version. These are the most-read endpoints during a sale, so they're cached (chapter 19). One important detail in the seat map query:

```ts
sql<SeatStatus>`CASE WHEN ${acquirableSql} THEN 'available'::seat_status ELSE es.status END`.as('status')
```

A seat whose hold has **lapsed** is shown as available right away, even before any background job has cleaned it up. That's "lazy expiry", explained in the next chapter.
