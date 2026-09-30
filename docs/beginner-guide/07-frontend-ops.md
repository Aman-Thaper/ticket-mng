# The browser page (public/app.js)

`public/` contains a demo page: `index.html` (the structure), `styles.css` (the look) and `app.js` (the behaviour). It is **plain JavaScript with no framework and no build step**, which makes it a great place to see how a front end talks to a back end.

## A tiny API client with automatic token refresh

```js
async function api(path, { method = 'GET', body, headers = {}, retryAuth = true } = {}) {
  const res = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'same-origin',                          // send cookies (the refresh cookie)
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // Access tokens live 15 minutes; on 401, trade the httpOnly refresh cookie for a new one.
  if (res.status === 401 && retryAuth && state.token && (await refreshSession())) {
    return api(path, { method, body, headers, retryAuth: false });   // retry once
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);    // uses the { error: { code, message } } shape
  return data;
}
```

Every call goes through this one function: it adds the access token, and when the server says "401, token expired", it silently calls `/auth/refresh` and retries once. The user never notices tokens expiring.

## Live updates: subscribe, then snapshot

```js
function connectLive(eventId) {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/events/${eventId}/live`);
  state.ws = ws;

  ws.onmessage = async (message) => {
    const data = JSON.parse(message.data);
    if (data.type === 'hello') {
      // Subscribed first, snapshot second: nothing can fall in between.
      await loadSnapshot(eventId, Date.now());
    } else if (data.type === 'seats') {
      if (state.snapshotReady) applyUpdates(data.seats);
      else state.buffered.push(...data.seats);        // updates that arrive during loading wait
    }
  };

  ws.onclose = (e) => {
    // Exponential backoff with jitter: a whole audience reconnecting at once (say, after a
    // deploy) shouldn't hit the servers in one synchronized wave.
    const delay = Math.min(15_000, 1_000 * 2 ** state.wsAttempt++) * (0.5 + Math.random() / 2);
    state.reconnectTimer = setTimeout(() => connectLive(eventId), delay);
  };
}

function applyUpdates(tuples) {
  for (const [id, status, version] of tuples) {
    const entry = state.seats.get(id);
    if (!entry || version <= entry.version) continue;   // stale or duplicate: ignore
    entry.status = status;
    entry.version = version;
    if (status !== 'available' && state.selected.has(id)) {
      state.selected.delete(id);
      showMessage(`${entry.label} was just taken by someone else.`);
    }
    paint(id, true);
  }
}
```

**Exponential backoff with jitter**: wait 1 s, 2 s, 4 s, 8 s... (capped at 15 s), each multiplied by a random 0.5 to 1. Without the randomness, 10,000 browsers disconnected by a deploy would all reconnect at exactly the same instant.

The seat map is drawn as **SVG**: one `<rect>` per seat at `(x, y)` from the API, coloured by status.

## Hold → pay → tickets

1. **Hold**: the page generates `crypto.randomUUID()` as the `Idempotency-Key` and calls `POST /events/:id/bookings`, retrying on network errors *with the same key* (`withNetworkRetry`), so a retry can never create a second booking. A countdown shows the 10-minute hold.
2. **Pay**: `POST /bookings/:id/payment` returns a client secret; the page sends the test card to `/fake-gateway/v1/payment_intents/:id/confirm` (standing in for Stripe.js).
3. **Wait**: the booking becomes confirmed only when the webhook has been processed by the worker, so the page **polls** `GET /bookings/:id` until the status changes (`waitForOutcome`). If it never does, it suggests checking that the worker is running.
4. **Tickets**: `GET /bookings/:id/tickets` returns the QR codes as images.

The server also sends a strict **Content-Security-Policy** header for these pages (in `app.ts`): only scripts from the same site may run, which blocks most injected-script (XSS) attacks.

# Staying fast under load

A flash sale sends more requests than the database can handle. This chapter covers how the app stays up. The guiding principle (ADR 0009): **fail fast and shed load; never queue without limit.**

## Two caches (`src/lib/cache.ts`)

**1. MicroCache: in-process, 1 second, for hot data that changes constantly** (seat maps, availability counts).

```ts
async get(key: string, load: () => Promise<string>) {
  const hit = this.entries.get(key);
  if (hit && hit.expires > Date.now()) return hit;               // fresh: return it
  const running = this.inflight.get(key);
  if (running) return running;                                   // someone is loading it: share!
  const loading = load().then((body) => { /* store with etag, expires = now + ttl */ })
                        .finally(() => this.inflight.delete(key));
  this.inflight.set(key, loading);
  return loading;
}
```

The second `if` is **single-flight**: when the entry expires and 1,000 requests arrive at once, only **one** runs the database query; the other 999 wait for that same promise. So seat-map load is at most **one query per second per server**, no matter how many people watch. Staleness of up to 1 second is fine because WebSockets deliver every change anyway.

Responses also get an **ETag** (a fingerprint of the body). A browser that already has that version sends `If-None-Match` and gets `304 Not Modified` with no body (`lib/http-cache.ts`).

**2. Redis read-through with generation counters: for data read a lot but changed rarely** (event pages, public listings).

The hard part of caching is *invalidation* (removing stale entries). The naive way, "delete the cache key after a write", has a race:

```text
reader: cache miss → SELECT (old data) ........................ SET cache = old data  ← stale!
writer:                         UPDATE, COMMIT, DELETE cache key
```

This project puts a **generation number** in the key: `cache:event:42:<gen>`. A write **increments** the generation after commit (`invalidate(...)` uses `afterCommit`). The slow reader above stores its stale data under the *old* generation, which nobody reads any more. Problem solved without any locks.

```ts
export async function readThrough(cache, baseKey, generations, ttlSeconds, load) {
  let key: string | null;
  try {
    const gens = generations.length ? await redis.mget(...generations) : [];
    key = `cache:${baseKey}:${gens.map((g) => g ?? '0').join('.')}`;
    const hit = await redis.get(key);
    if (hit !== null) return { body: hit, etag: etagOf(hit) };
  } catch (err) {
    key = null;                          // Redis down: just read the database (slower, never wrong)
  }
  const body = await load();
  if (key) redis.set(key, body, 'EX', ttlSeconds).catch(() => {});
  return { body, etag: etagOf(body) };
}
```

<div class="note">The cache is never used to <b>decide</b> anything important. Holding a seat always checks Postgres. Caches only serve reads.</div>

## Rate limiting: the token bucket (`src/lib/rate-limit.ts`)

Picture a bucket holding up to `capacity` tokens, refilled at `refillPerSec`. Each request takes one token. Empty bucket → `429 Too Many Requests` with a `Retry-After` header. This allows short bursts but limits the sustained rate.

The bucket lives in **Redis**, so all three API servers share it (in-memory limits would give each server its own allowance, tripling the real limit). The read-modify-write runs as a **Lua script**, which Redis executes atomically, so two concurrent requests can't both spend the last token. It uses Redis's own clock (`redis.call('TIME')`) because app servers' clocks may differ.

Limits in the app:

| Limit | Where |
|---|---|
| 120 burst / 30 per second per IP, for the whole API | `app.ts` hook |
| holds: 10 burst, then 1 every 2 s per user | `bookings/routes.ts` |
| login: per IP and per IP+email | `auth/routes.ts` |
| signup, password reset, password change | `auth/routes.ts` |

Like the other Redis features, it **fails open**: if Redis is down, requests are allowed.

## Overload: bounded waiting and cheap rejections

- **Cheap rejections first**: rate limits (429) and the claim gate (409) turn away work *before* it takes a database connection.
- **Bounded waiting**: a request waits at most 5 s for a pool connection, then gets `503` + `Retry-After`. Postgres kills statements after 15 s.
- **Pool arithmetic**: 3 API servers × 20 connections + worker 10 + a listener must stay below Postgres's `max_connections` (set to 200 in `docker-compose.yml`). Bigger pools don't help: more connections make Postgres *slower* under contention.
- **Nginx must not amplify.** A real bug they found under load (commented in `deploy/nginx/local.conf`): Nginx was set to retry on `503`. It counted every deliberate 503 as a server failure, marked all three servers dead, and answered **everything** with 502 for seconds. The fix: `proxy_next_upstream error timeout;` (retry only when a server can't be reached).
- **Least connections**: `least_conn` sends each request to the server with the fewest in-flight requests, better than round-robin when some requests (holds) are much slower than others (cached reads).

The result measured in the load test (k6, 1,000 buyers per second on a laptop): 0 errors, holds at 1.4 s at the 95th percentile, and the invariant check found no double sale.

## Checking the rules after the storm (`src/lib/invariants.ts`)

Each invariant is a SQL query that returns the rows breaking a rule, so a healthy database returns nothing: "a seat belongs to more than one active booking", "a booked seat whose booking isn't confirmed", "a succeeded payment that neither confirmed its booking nor was refunded", and more. They run after tests, after load tests (`npm run check:invariants`) and on demand (`GET /admin/invariants`). This is how "no seat was sold twice" is **verified rather than assumed**.

# Logs, metrics, health checks, shutdown

When something breaks in production you can't attach a debugger. You need to *observe* the system.

## Structured logs (`src/lib/logger.ts`)

The app uses **pino** and writes one **JSON** line per event:

```json
{"level":"info","time":"2026-09-30T12:00:00.000Z","instance":"api-2:1","requestId":"4f1c...","userId":"9ab...","msg":"request completed","res":{"statusCode":201},"responseTime":38}
```

- JSON lines can be searched and filtered by log tools (`requestId = "4f1c..."`).
- Every line has the **instance** and, for requests, the **request id**. The outbox stores that request id with each job, and the worker logs it, so **one id follows a click through Nginx, the API and every background job it caused**.
- **Redaction**: `authorization` headers, cookies, passwords, tokens and client secrets are replaced with `[redacted]` automatically.
- `LOG_PRETTY=true npm run dev` prints human-friendly lines during development.

## Metrics (`src/lib/metrics.ts`)

Metrics are numbers over time, scraped by **Prometheus** from `GET /metrics` and graphed by **Grafana** (a dashboard is included in `deploy/monitoring/`).

- `http_request_duration_seconds{method, route, status_code}`: a histogram, by route *template* (`/events/:id`, not every real id, which would create millions of series);
- `http_requests_in_flight`;
- `db_pool_connections{state}` (a rising `waiting` count means the database is the bottleneck);
- `cache_requests_total{cache, result}` (hit / miss / coalesced);
- `booking_hold_attempts_total{strategy, outcome}`;
- `job_duration_seconds`, `queue_jobs{queue, state}`, `outbox_unpublished` (a growing age means the relay is stuck);
- `websocket_connections`, plus Node's own (event-loop lag, memory, GC).

## Health checks (`src/modules/health/`)

Two endpoints, deliberately different:

- `GET /health/live` ("liveness"): *can the process answer at all?* No dependency checks. If the database is down, restarting the app won't fix it, and restarting every container in a loop would make things worse.
- `GET /health/ready` ("readiness"): *should traffic come here?* Checks the database (`SELECT 1`) and Redis (`PING`) with 1-second timeouts, and returns 503 while shutting down. Docker's `HEALTHCHECK` and the rollout script use this.

## Graceful shutdown (again, now you can see why)

On `SIGTERM`: `lifecycle.beginShutdown()` makes `/health/ready` return 503 → the load balancer stops sending new requests → after `SHUTDOWN_DRAIN_MS` the server stops listening, finishes in-flight requests, closes WebSockets with code 1001 (browsers reconnect elsewhere), then closes the database pool and Redis. The worker similarly stops the relay, waits for running jobs to finish, and exits.

# Docker, Nginx, CI and deploying

## The Dockerfile: one image, three roles

```dockerfile
FROM node:24-slim AS base
WORKDIR /app

FROM base AS deps                        # production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM base AS build                       # compile TypeScript
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM base AS runtime                     # the final, small image
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
USER node                                # don't run as root
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 CMD [...fetch /health/ready...]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
```

- **Multi-stage build**: TypeScript and dev tools exist only in the `build` stage; the final image has just compiled JavaScript and production dependencies. Smaller and safer.
- **One image, three roles**: `node dist/server.js` (API, the default), `node dist/worker.js` (worker), `node dist/db/migrate.js latest` (migrations). Compose chooses by overriding the command.
- **`USER node`**: if an attacker breaks in, they're not root.
- **tini as PID 1**: inside a container, process #1 doesn't get default signal handling. tini forwards `SIGTERM` to Node so graceful shutdown really runs, and cleans up zombie processes.

## docker-compose.yml: the whole system with one command

`docker compose up -d --build` starts: **postgres**, **redis** (with `noeviction`, because BullMQ's keys must never be evicted), **minio** (S3-compatible file storage), **mailpit** (catches outgoing emails so you can view them at `localhost:8025`), a one-shot **migrate** container, **3 API replicas**, the **worker**, and **nginx** on port 8080. An optional `monitoring` profile adds Prometheus and Grafana. Services wait for each other with health checks (`depends_on: condition: service_healthy`).

The settings go in as environment variables, the same `config.ts` schema validates them, and development defaults are used unless you override them.

## Nginx

In front of the API replicas (see `deploy/nginx/`):

- `upstream api { least_conn; ... }`: load balancing;
- WebSocket support (`Upgrade` / `Connection` headers, 1-hour timeouts);
- `X-Request-Id $request_id` so Nginx's logs and the app's logs share ids;
- `X-Forwarded-For` so the app knows the real client IP (and the app trusts that header **only** from Nginx's address: `TRUST_PROXY`, otherwise clients could fake their IP to dodge rate limits);
- in production: HTTPS with Let's Encrypt certificates, an edge rate limit, and `/metrics` blocked from the public.

## CI: GitHub Actions (`.github/workflows/ci.yml`)

On every push and pull request, GitHub runs:

1. **checks**: `npm ci`, lint (ESLint), format check (Prettier), typecheck (`tsc --noEmit`), build;
2. **test**: the full test suite against real Postgres, Redis, MinIO and `stripe-mock` (Stripe's official fake API) started as service containers;
3. **docker**: builds the image (and on `main`, pushes it to GitHub's container registry tagged with the commit SHA);
4. **smoke**: starts the entire stack with Compose, runs a real headless-browser test of the seat map, a k6 load test, a zero-downtime rollout under load, and the invariant check.

## Deploying (`deploy.yml`, `deploy/rollout.sh`, `docs/DEPLOY.md`)

Production is one VPS running Docker Compose. A deploy (run manually from GitHub Actions with a commit SHA):

1. pulls the image CI already built for that commit (servers never build);
2. runs **migrations first**. Migrations only ever *add* things (new columns, new tables); removals come a release later ("expand, then contract"), so the old code keeps working during the deploy and rolling back is just deploying the previous image;
3. runs `deploy/rollout.sh` for the API: start new replicas next to the old ones, wait until healthy, point Nginx at the new ones (graceful reload), stop the old ones (they drain), then point Nginx back at the service name;
4. updates the worker and the rest.

Why a script instead of `docker compose up -d`? They measured it under 65 requests/second: plain `up -d` failed 336 of 2,927 requests, replacing replicas and relying on DNS failed 3, the rollout script failed **0**. CI repeats that check on every push.

Also important for production (`config.ts` and `DEPLOY.md`): secrets live in a `chmod 600` `.env.production` file on the server, never in git; the app refuses to start with development secrets; only ports 80 and 443 are open.

# Tests

Tests live in `test/` and run with **Vitest** (`npm test`). `vitest.config.ts` defines two groups:

- **unit** (`test/unit/`): pure functions, no database: seat layout generation, pagination cursors, webhook signatures, ticket signing, the Stripe provider against `stripe-mock`. Fast; run with `npm run test:unit`.
- **api** (`test/api/`): real HTTP-level tests against a real Postgres and Redis (a separate test database, wiped before each test). Files run one at a time because they share the database.

`test/helpers.ts` provides the setup every API test file uses:

```ts
export function useApp() {
  const ctx = {} as { app: FastifyInstance };
  beforeAll(async () => {
    ctx.app = await buildApp({ logger: false });      // the real app, no real port
    await ctx.app.ready();
    configureDelivery({ mode: 'sync', deliverer: async (body, headers) =>
      (await ctx.app.inject({ method: 'POST', url: '/api/v1/webhooks/fake', payload: body, headers })).statusCode });
  });
  beforeEach(async () => { await resetState(); });    // truncate every table, flush Redis
  afterAll(async () => { await ctx.app.close(); /* close db, redis, queues */ });
  return ctx;
}
```

- `app.inject({ method, url, headers, payload })` sends a fake HTTP request straight into Fastify, no network needed. That's why `buildApp` is a function.
- The fake payment gateway delivers its webhooks synchronously into the same app, so a test knows the webhook has landed when the payment call returns.
- Helpers like `createUser`, `createVenue`, `createEvent`, `publish`, `payFor` keep each test short.

The real concurrency test from `test/api/bookings.test.ts` reads like a story. It runs once for each correct strategy:

```ts
describe.each<HoldStrategy>(['pessimistic', 'optimistic', 'serializable'])(
  'concurrency with the %s strategy',
  (strategy) => {
    it('30 buyers race for one seat: exactly one wins, the rest get a clean 409', async () => {
      // Gate off, so every attempt really reaches the database transaction.
      const app = await buildApp({ logger: false }, { booking: { strategy, claimGate: false } });
      try {
        const buyers = await Promise.all(Array.from({ length: 30 }, () => createUser('attendee')));
        const results = await Promise.all(buyers.map((b) => hold(b, [seatIds[0]!], eventId, app)));
        const codes = results.map((r) => r.statusCode);
        expect(codes.filter((c) => c === 201)).toHaveLength(1);
        expect(codes.filter((c) => c === 409)).toHaveLength(29);

        // ...and the database agrees: exactly one pending booking holds that seat
        const holders = await db.selectFrom('bookingItems as bi')
          .innerJoin('bookings as b', 'b.id', 'bi.bookingId')
          .where('bi.eventSeatId', '=', seatIds[0]!).where('b.status', '=', 'pending')
          .select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
        expect(holders.n).toBe(1);
      } finally {
        await app.close();
      }
    });
  },
);
```

`Promise.all` fires all 30 requests at once, which is how you test a race. The test checks both the HTTP answers *and* the database.

Other testing tools in `scripts/`: `race-test.ts` (200 concurrent holds per strategy), `loadtest/flash-sale.js` (k6), `e2e-seatmap.ts` (Playwright: a buyer and a watcher in two headless browsers), `check-invariants.ts`, and `seed.ts` (creates ~1.5 million rows of realistic demo data; every seeded user's password is `password123`).

<div class="tip"><b>Lesson:</b> test at the level where bugs actually happen. For a backend, that's usually "send a real HTTP request to the real app with a real database and check the response and the database". Mocks everywhere tend to test your mocks.</div>
