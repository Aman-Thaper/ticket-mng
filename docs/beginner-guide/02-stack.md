# The tools (the stack) and why each one is there

A "stack" is the set of tools a project is built with. Beginners often think "a backend = one program". In reality, a backend is **your program plus several services it talks to**. Here is the whole system as a picture:

<div class="diagram">
<svg viewBox="0 0 760 420" xmlns="http://www.w3.org/2000/svg" font-family="DejaVu Sans, sans-serif" font-size="12">
  <defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#555"/></marker></defs>
  <rect x="20" y="20" width="150" height="50" rx="8" fill="#e8f0fe" stroke="#4a6fd1"/><text x="95" y="42" text-anchor="middle" font-weight="bold">Browser</text><text x="95" y="58" text-anchor="middle">seat-map page</text>
  <rect x="20" y="90" width="150" height="50" rx="8" fill="#e8f0fe" stroke="#4a6fd1"/><text x="95" y="112" text-anchor="middle" font-weight="bold">Other clients</text><text x="95" y="128" text-anchor="middle">Swagger UI, scripts</text>
  <rect x="230" y="55" width="120" height="50" rx="8" fill="#fff4e0" stroke="#d18a1f"/><text x="290" y="77" text-anchor="middle" font-weight="bold">Nginx</text><text x="290" y="93" text-anchor="middle">front door</text>
  <line x1="170" y1="45" x2="228" y2="72" stroke="#555" marker-end="url(#a)"/><line x1="170" y1="115" x2="228" y2="90" stroke="#555" marker-end="url(#a)"/>
  <rect x="410" y="15" width="140" height="36" rx="8" fill="#e6f5ea" stroke="#2e8b57"/><text x="480" y="38" text-anchor="middle" font-weight="bold">API replica 1</text>
  <rect x="410" y="62" width="140" height="36" rx="8" fill="#e6f5ea" stroke="#2e8b57"/><text x="480" y="85" text-anchor="middle" font-weight="bold">API replica 2</text>
  <rect x="410" y="109" width="140" height="36" rx="8" fill="#e6f5ea" stroke="#2e8b57"/><text x="480" y="132" text-anchor="middle" font-weight="bold">API replica 3</text>
  <line x1="350" y1="72" x2="408" y2="35" stroke="#555" marker-end="url(#a)"/><line x1="350" y1="80" x2="408" y2="80" stroke="#555" marker-end="url(#a)"/><line x1="350" y1="88" x2="408" y2="125" stroke="#555" marker-end="url(#a)"/>
  <rect x="330" y="230" width="170" height="60" rx="8" fill="#fde8e8" stroke="#c0392b"/><text x="415" y="255" text-anchor="middle" font-weight="bold">PostgreSQL</text><text x="415" y="272" text-anchor="middle">the source of truth</text>
  <rect x="560" y="230" width="180" height="60" rx="8" fill="#f3e8fd" stroke="#8e44ad"/><text x="650" y="252" text-anchor="middle" font-weight="bold">Redis</text><text x="650" y="268" text-anchor="middle">cache, limits, pub/sub,</text><text x="650" y="282" text-anchor="middle">job queues</text>
  <line x1="470" y1="145" x2="430" y2="228" stroke="#555" marker-end="url(#a)"/><line x1="500" y1="145" x2="630" y2="228" stroke="#555" marker-end="url(#a)"/>
  <rect x="330" y="340" width="170" height="50" rx="8" fill="#e6f5ea" stroke="#2e8b57"/><text x="415" y="362" text-anchor="middle" font-weight="bold">Worker</text><text x="415" y="378" text-anchor="middle">background jobs</text>
  <line x1="415" y1="340" x2="415" y2="292" stroke="#555" marker-end="url(#a)"/><line x1="480" y1="340" x2="600" y2="292" stroke="#555" marker-end="url(#a)"/>
  <rect x="20" y="300" width="140" height="40" rx="8" fill="#eee" stroke="#777"/><text x="90" y="324" text-anchor="middle">Email server (SMTP)</text>
  <rect x="20" y="355" width="140" height="40" rx="8" fill="#eee" stroke="#777"/><text x="90" y="379" text-anchor="middle">S3 / MinIO (files)</text>
  <line x1="328" y1="360" x2="162" y2="322" stroke="#555" marker-end="url(#a)"/><line x1="328" y1="370" x2="162" y2="374" stroke="#555" marker-end="url(#a)"/>
  <rect x="600" y="340" width="140" height="50" rx="8" fill="#eee" stroke="#777"/><text x="670" y="362" text-anchor="middle">Payment provider</text><text x="670" y="378" text-anchor="middle">Stripe / fake</text>
  <path d="M550,30 L754,30 L754,365 L742,365" fill="none" stroke="#999" stroke-dasharray="4 3" marker-end="url(#a)"/>
</svg>
<div class="caption">The whole system. Arrows mean "talks to". Everything in green is <i>our</i> code (the same codebase run in different ways).</div>
</div>

Now each tool, what it is, and **why this project uses it**.

**Node.js (version 24).** A program that runs JavaScript outside the browser. Node is good at servers because it handles thousands of connections at once using an *event loop*: instead of waiting (blocking) while the database answers, it moves on to other requests and comes back when the answer arrives. That is why you see `async` / `await` everywhere in the code.

**TypeScript.** JavaScript plus *types*. You write `function f(id: string): Promise<Booking>` and the compiler checks, before the program runs, that you never pass a number where a string is expected. In a big project this catches a huge number of mistakes. TypeScript is compiled (`npm run build`) into plain JavaScript in the `dist/` folder, and that is what runs in production. In development, `tsx` runs `.ts` files directly.

**Fastify.** The web framework: it listens for HTTP requests and calls your handler for each route. It is like Express but faster and with built-in support for schemas (descriptions of what the input and output look like). It has **hooks** (functions that run at stages of every request, like "on request" and "on response") and **plugins** (a way to group routes and settings).

**Zod.** A library to describe the *shape* of data: `z.object({ email: z.email(), password: z.string().min(8) })`. In this project, one Zod schema per route does three jobs at once: it **validates** incoming data (bad input gets a `400` automatically), gives TypeScript the **types**, and generates the **API documentation** you see at `/docs`.

**PostgreSQL.** The database. It is the **single source of truth**: who owns which seat, what was paid, which ticket is valid. It also *enforces rules itself* (constraints), so even buggy code can't break them.

**Kysely.** A "query builder": you write database queries in TypeScript, like `db.selectFrom('users').where('id', '=', id)`, and it produces SQL. Unlike an ORM (such as Prisma), it doesn't hide the SQL, which matters because this project needs precise control over locking.

**Redis.** A very fast in-memory store. Here it is used for: caches, rate limits, the "claim gate" (a fast pre-check before booking seats), a denylist of logged-out sessions, pub/sub messages for live seat updates, and the job queues. Important rule of this project: **Postgres decides, Redis accelerates**. If Redis loses its data, nothing important is lost.

**BullMQ.** A job-queue library built on Redis. The API adds jobs; the worker process takes them and runs them, with retries.

**WebSockets.** Long-lived connections so the server can push seat updates to browsers instantly.

**Nginx.** A web server placed *in front of* the app (a "reverse proxy"). It handles HTTPS encryption, spreads requests across the 3 API copies (load balancing), and applies a first rate limit.

**Docker and Docker Compose.** Docker packages the app into an *image*. Compose starts many containers together (Postgres, Redis, 3 API copies, worker, Nginx...) with one command: `docker compose up`.

**Others.** `pino` (logging), `prom-client` (metrics for Prometheus), `jose` (JWT tokens), `@node-rs/argon2` (password hashing), `sharp` (image resizing), `nodemailer` (email), `qrcode` (QR images), `@aws-sdk/client-s3` (file storage), `stripe` (payments), `vitest` (tests), `eslint`/`prettier` (code style), `k6` (load testing), `playwright` (browser tests).

<div class="tip"><b>Lesson for your own projects.</b> You do not need all of these to start. A first project needs: a language + a web framework + a database. Add Redis, queues, WebSockets, Docker only when you have the problem they solve. This project added them in phases (see the roadmap in <code>README.md</code>), which is exactly how you should grow a project too.</div>

# A tour of the folders

```text
ticket-mng/
├── package.json          project name, dependencies, and the npm scripts (commands)
├── tsconfig.json         TypeScript compiler settings
├── .env.example          example settings; copy to .env for local development
├── Dockerfile            how to build the Docker image
├── docker-compose.yml    the whole system on one machine
├── src/                  THE APPLICATION CODE
│   ├── server.ts         entry point #1: starts the HTTP API
│   ├── worker.ts         entry point #2: starts the background-job worker
│   ├── app.ts            builds the Fastify app: hooks, plugins, routes
│   ├── config.ts         reads and validates environment variables
│   ├── db/               database connection, transactions, migrations, table types
│   ├── lib/              shared helpers: errors, logging, caching, rate limits, ...
│   ├── modules/          one folder per feature (auth, users, venues, events, ...)
│   ├── jobs/             queues, the outbox relay, job runner, job handlers, schedules
│   ├── realtime/         live seat-map updates (WebSockets + Redis pub/sub)
│   ├── emails/           email templates
│   └── fake-gateway/     a pretend payment provider for offline development
├── public/               the browser page (index.html, app.js, styles.css)
├── test/                 automated tests (unit + API)
├── scripts/              seed data, race test, load tests, checks
├── deploy/               production configs: Nginx, monitoring, rollout script
└── docs/                 architecture notes, decision records (ADRs), study guide
```

**The most important organising idea: "modules" by feature.** Look inside `src/modules/`:

```text
modules/
  auth/       signup, login, tokens, sessions, password reset
  users/      profiles and roles
  venues/     venues and generating seat layouts
  events/     events, search, seat maps, posters
  bookings/   holding seats, cancelling, expiring (the hard part)
  payments/   paying, webhooks, refunds
  tickets/    QR tickets and check-in
  admin/      queue inspection, invariant checks
  health/     "am I alive / ready?" endpoints
```

Each module usually has:

- `routes.ts`: the HTTP endpoints (URL, input schema, output schema, and a short handler);
- `service.ts`: the business logic (the actual rules), independent of HTTP;
- sometimes `schemas.ts` / `dto.ts` (data shapes) and helpers.

<div class="tip"><b>Why split routes from services?</b> The route deals with HTTP things (headers, status codes, who is logged in). The service deals with business rules ("a seat can only be held if free"). This way the same service can be called from an HTTP route, from a background job, or from a test, without HTTP being involved. The booking service, for example, is called by the booking route <i>and</i> by the worker's expiry job.</div>

**`src/lib/` is the toolbox.** Things used by many modules: `errors.ts` (one error format), `logger.ts`, `metrics.ts`, `cache.ts`, `rate-limit.ts`, `idempotency.ts`, `pagination.ts`, `redis.ts`, `storage.ts` (file uploads), `mailer.ts` (email), and so on.

# How the program starts

## Step 0: npm scripts

`package.json` lists the commands you run. The important ones:

```json
"scripts": {
  "dev": "tsx watch src/server.ts",
  "worker": "tsx watch src/worker.ts",
  "migrate": "tsx src/db/migrate.ts latest",
  "seed": "tsx scripts/seed.ts",
  "test": "vitest run",
  "build": "tsc -p tsconfig.build.json",
  "start": "node dist/server.js",
  "start:worker": "node dist/worker.js"
}
```

- `npm run dev` runs `src/server.ts` with `tsx` in *watch mode* (it restarts when you save a file).
- `npm run worker` does the same for the worker.
- `npm run migrate` creates/updates the database tables.
- `npm run build` compiles TypeScript to JavaScript in `dist/`; `npm start` runs that compiled code (what production does).

So in development you open **two terminals**: one with `npm run dev` (API), one with `npm run worker` (jobs). Both need Postgres and Redis running.

## Step 1: configuration (`src/config.ts`)

The very first thing that happens is reading settings. Here is the pattern, shortened:

```ts
import { z } from 'zod';

// Load .env if present. Real environment variables win over the file.
try {
  process.loadEnvFile();
} catch {
  // no .env file, which is fine in CI/production
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  HOLD_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(600),
  // ... about 50 settings in total
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:\n' + z.prettifyError(parsed.error));
  process.exit(1);
}
// ... extra production safety checks ...
export const config = parsed.data;
```

Line by line:

- `process.loadEnvFile()` reads the `.env` file (a list of `KEY=value` lines) into `process.env`. It's wrapped in `try` because in production there is no `.env` file; settings come from the real environment.
- `schema` describes **every setting**: its type, limits and default. `z.coerce.number()` converts the text `"3000"` into the number `3000` (environment variables are always text).
- `schema.safeParse(process.env)` checks all settings at once. If anything is wrong (a missing `DATABASE_URL`, a secret that's too short), the program prints a clear message and **stops immediately** with `process.exit(1)`.
- `export const config = parsed.data;` Every other file imports `config` and gets typed, validated values: `config.PORT` is guaranteed to be a positive integer.

Below the schema are **production guards**: the app refuses to start in production with the development secrets from `.env.example`, with the fake payment gateway, or with the deliberately broken `naive` booking strategy.

```ts
if (parsed.data.NODE_ENV === 'production' && parsed.data.PAYMENT_PROVIDER === 'fake') {
  console.error('The fake payment gateway accepts any test card; it is not allowed in production');
  process.exit(1);
}
```

<div class="tip"><b>Lesson: fail fast at startup.</b> If a setting is wrong, it is far better to crash immediately with a clear message than to start "successfully" and fail an hour later when the first user tries to pay. Copy this pattern into every project.</div>

## Step 2: the entry point (`src/server.ts`)

```ts
const app = await buildApp({ loggerInstance: logger });

async function closeResources() {
  await closeQueues();
  await Promise.allSettled([db.destroy(), redis.quit()]);
}

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    lifecycle.beginShutdown();
    void (async () => {
      if (config.SHUTDOWN_DRAIN_MS) await sleep(config.SHUTDOWN_DRAIN_MS);
      await app.close();
      await closeResources();
      process.exit(0);
    })();
  });
}

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (err) {
  app.log.error(err);
  await closeResources();
  process.exit(1);
}
```

What it does:

1. `buildApp(...)` builds the whole web application (next section).
2. It registers **signal handlers**. When you press Ctrl+C (`SIGINT`) or Docker stops the container (`SIGTERM`), instead of dying instantly the server shuts down *gracefully*: it marks itself "not ready" (so the load balancer stops sending traffic), optionally waits a bit (`SHUTDOWN_DRAIN_MS`), stops accepting new connections, lets in-flight requests finish, and closes the database and Redis connections. This is why deploys don't drop requests (chapter 20).
3. `app.listen(...)` opens the port (3000 by default). From now on, the server answers requests.

Note the top-level `await`: this file is an ES module (`"type": "module"` in `package.json`), so it can use `await` outside a function.

## Step 3: building the app (`src/app.ts`)

`buildApp` is the "assembly line" of the server. It is long, so here are its parts in order:

```ts
export async function buildApp(opts: FastifyServerOptions = {}, overrides: AppOverrides = {}) {
  const app = Fastify({
    genReqId,                                   // how to name each request
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
    ...opts,
    trustProxy,                                 // believe X-Forwarded-For only from Nginx
  }).withTypeProvider<ZodTypeProvider>();
```

- `Fastify({...})` creates the server object.
- `genReqId` gives each request an **id**. If Nginx already sent an `X-Request-Id` header (and it looks safe), that id is reused, otherwise a random UUID is generated. Every log line of that request includes this id, so you can find all lines of one request.
- `.withTypeProvider<ZodTypeProvider>()` tells TypeScript "route schemas are Zod schemas", so inside a handler `req.body` has the right type automatically.

Then **hooks** are added. A hook is a function Fastify runs at a certain moment of *every* request:

```ts
  app.addHook('onRequest', async () => {
    httpRequestsInFlight.inc();                 // metrics: one more request running
  });
  app.addHook('onResponse', async (req, reply) => {
    httpRequestsInFlight.dec();
    httpRequestDuration.observe({ method: req.method, route: req.routeOptions.url ?? 'unmatched',
      status_code: String(reply.statusCode) }, reply.elapsedTime / 1000);
  });

  // Make the request id available everywhere without passing it around
  app.addHook('onRequest', (req, _reply, done) => requestContext.run({ requestId: req.id }, done));

  // Per-IP rate limit for the whole API (shared across servers via Redis)
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/') || req.url.startsWith('/api/v1/webhooks/')) return;
    await enforce(req, reply, [[rule, req.ip]]);
  });

  // Add x-served-by and x-request-id headers to every response
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-served-by', INSTANCE_ID).header('x-request-id', req.id);
  });
```

Then **plugins** and settings:

```ts
  const hub = new LiveSeatHub();                // live seat updates (chapter 17)
  app.decorate('liveHub', hub);
  app.addHook('preClose', async () => hub.close());
  await app.register(websocket, { options: { maxPayload: 4096 } });

  app.setValidatorCompiler(validatorCompiler);  // use Zod to validate input
  app.setSerializerCompiler(serializerCompiler);// use Zod to shape output

  await app.register(cookie);                   // read/write cookies
  app.decorateRequest('user', null);            // every request gets req.user (null = anonymous)

  await app.register(swagger, { openapi: { /* title, tags, security */ } });
  await app.register(swaggerUi, { routePrefix: '/docs' });  // interactive docs at /docs

  app.setErrorHandler(errorHandler);            // one place turns errors into JSON (chapter 9)
  app.setNotFoundHandler(/* JSON 404 */);

  await app.register(fastifyStatic, { root: PUBLIC_DIR, /* security headers */ });  // serves public/
```

- `app.decorate('name', value)` attaches something to the app object so any route can use it (`app.liveHub`).
- `app.register(plugin)` plugs in a feature. `@fastify/cookie` adds cookie support, `@fastify/swagger` builds API docs, `@fastify/static` serves files from `public/` (the seat-map page).

Finally, **routes**:

```ts
  await app.register(healthRoutes);
  if (config.PAYMENT_PROVIDER === 'fake') await app.register(fakeGatewayRoutes);
  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(userRoutes);
      await api.register(venueRoutes);
      await api.register(eventRoutes);
      await api.register(posterRoutes);
      await api.register(bookingRoutes);
      await api.register(paymentRoutes);
      await api.register(ticketRoutes);
      await api.register(adminRoutes);
    },
    { prefix: '/api/v1' },
  );
  return app;
}
```

Each `xxxRoutes` is a plugin defined in `src/modules/xxx/routes.ts`. Registering them inside a plugin with `prefix: '/api/v1'` means a route written as `/auth/login` in `auth/routes.ts` is actually served at `/api/v1/auth/login`.

<div class="tip"><b>Why <code>buildApp</code> is a function instead of code that runs at import.</b> Tests call <code>buildApp()</code> to get a fresh app without opening a real port (<code>app.inject(...)</code> sends fake requests). The race-test script calls it with different booking strategies. Making your app "buildable" by a function is a great habit.</div>

## Step 4: the worker entry point (`src/worker.ts`)

The worker is the same codebase with a different starting file. It does not answer HTTP API calls; it:

1. creates one BullMQ `Worker` per queue (`email`, `bookings`, `payments`, `media`, `maintenance`) with a *concurrency* (how many jobs of that queue run at once);
2. starts the **outbox relay** (chapter 13), which moves jobs from the database into Redis;
3. registers **recurring schedules** (every 30 s, every 15 min, daily at 03:00);
4. starts a tiny HTTP server only for health checks and metrics (port 3100);
5. handles `SIGTERM` gracefully (finish running jobs, then exit).

```ts
const workers = [
  createWorker('email', handlers.email, 10),        // I/O bound: many in parallel
  createWorker('bookings', handlers.bookings, 20),
  createWorker('payments', handlers.payments, 10),
  createWorker('media', handlers.media, 2),         // CPU heavy (image resizing): few
  createWorker('maintenance', handlers.maintenance, 1),
];
const relay = new OutboxRelay();
await relay.start();
await registerSchedules();
```

<div class="note"><b>Why two processes?</b> If sending an email took 2 seconds inside the request, the buyer would wait 2 seconds, and if the email server were down, the purchase would fail. Moving slow or retryable work into a separate worker keeps requests fast and reliable, and lets you scale each part separately (more workers for a big email backlog, more API copies for traffic).</div>
