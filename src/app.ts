import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { LogController, type FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { config } from './config.js';
import { requestContext } from './lib/context.js';
import { INSTANCE_ID } from './lib/logger.js';
import { httpRequestDuration, httpRequestsInFlight } from './lib/metrics.js';
import { enforce, type RateLimitRule } from './lib/rate-limit.js';
import { LiveSeatHub } from './realtime/hub.js';
import { errorHandler } from './lib/errors.js';
import { transformObject } from './lib/openapi.js';
import { adminRoutes } from './modules/admin/routes.js';
import { authRoutes } from './modules/auth/routes.js';
import { bookingRoutes } from './modules/bookings/routes.js';
import type { BookingOptions } from './modules/bookings/service.js';
import { healthRoutes } from './modules/health/routes.js';
import { organizerRoutes } from './modules/organizer/routes.js';
import { userRoutes } from './modules/users/routes.js';
import { venueRoutes } from './modules/venues/routes.js';
import { eventRoutes } from './modules/events/routes.js';
import { paymentRoutes } from './modules/payments/routes.js';
import { fakeGatewayRoutes } from './fake-gateway/routes.js';
import { posterRoutes } from './modules/events/posters.js';
import { ticketRoutes } from './modules/tickets/routes.js';

declare module 'fastify' {
  interface FastifyInstance {
    liveHub: LiveSeatHub;
  }
}

export interface AppOverrides {
  /** Lets scripts (e.g. the race test) run the booking flow with a different strategy. */
  booking?: Partial<BookingOptions>;
  /** Per-IP API rate limit; tests and load tests adjust it. */
  rateLimit?: { enabled: boolean; capacity?: number; refillPerSec?: number };
}

/**
 * Request id: reuse the one Nginx assigned (so its access log and ours line up), but only if
 * it looks like an id. A client-controlled header must not be able to inject log lines.
 */
const VALID_REQUEST_ID = /^[\w.-]{1,128}$/;
const genReqId = (req: { headers: Record<string, string | string[] | undefined> }) => {
  const incoming = req.headers['x-request-id'];
  return typeof incoming === 'string' && VALID_REQUEST_ID.test(incoming) ? incoming : randomUUID();
};

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

/** Browser security policy for the demo pages: only our own scripts, styles and API. */
const PAGES = [
  'login',
  'signup',
  'forgot-password',
  'reset-password',
  'verify-email',
  'my-tickets',
  'scan',
  'organizer',
] as const;

const STATIC_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  `img-src 'self' data: ${config.S3_PUBLIC_URL}`,
  // Poster uploads go from the browser straight to object storage (a presigned POST).
  `connect-src 'self' ${new URL(config.S3_PUBLIC_URL).origin}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

/** TRUST_PROXY as Fastify wants it: a hop count becomes "trust the nearest N proxies". */
const trustProxy =
  typeof config.TRUST_PROXY === 'number'
    ? (_address: string, hop: number) => hop < (config.TRUST_PROXY as number)
    : config.TRUST_PROXY;

export async function buildApp(opts: FastifyServerOptions = {}, overrides: AppOverrides = {}) {
  // trustProxy decides whose X-Forwarded-For to believe (see TRUST_PROXY in config.ts).
  const app = Fastify({
    genReqId,
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
    ...opts,
    trustProxy,
  }).withTypeProvider<ZodTypeProvider>();

  // RED metrics (rate, errors, duration) per route template, for every request.
  app.addHook('onRequest', async () => {
    httpRequestsInFlight.inc();
  });
  app.addHook('onResponse', async (req, reply) => {
    httpRequestsInFlight.dec();
    httpRequestDuration.observe(
      {
        method: req.method,
        route: req.routeOptions.url ?? 'unmatched',
        status_code: String(reply.statusCode),
      },
      reply.elapsedTime / 1000,
    );
  });

  app.decorate('bookingOptions', {
    strategy: config.HOLD_STRATEGY,
    claimGate: config.CLAIM_GATE_ENABLED,
    holdTtlSeconds: config.HOLD_TTL_SECONDS,
    ...overrides.booking,
  });

  // Everything that runs for a request (handlers, and code deep inside services such as the
  // outbox) can read the request id from here without it being passed around.
  app.addHook('onRequest', (req, _reply, done) => requestContext.run({ requestId: req.id }, done));

  // Per-client-IP limit on the whole API, shared across instances through Redis. It runs
  // before auth and body parsing, so a flood is turned away as cheaply as possible. Provider
  // webhooks are exempt: their source IPs are shared and bursty, and they are signed anyway.
  const rateLimit = overrides.rateLimit ?? { enabled: config.RATE_LIMIT_ENABLED };
  if (rateLimit.enabled) {
    const rule: RateLimitRule = {
      name: 'api:ip',
      capacity: rateLimit.capacity ?? config.RATE_LIMIT_IP_CAPACITY,
      refillPerSec: rateLimit.refillPerSec ?? config.RATE_LIMIT_IP_REFILL_PER_SEC,
    };
    app.addHook('onRequest', async (req, reply) => {
      if (!req.url.startsWith('/api/') || req.url.startsWith('/api/v1/webhooks/')) return;
      await enforce(req, reply, [[rule, req.ip]]);
    });
  }

  // Which instance answered (handy for watching the load balancer spread requests), and the
  // request id to quote in a bug report.
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-served-by', INSTANCE_ID).header('x-request-id', req.id);
  });

  // Live seat maps. The hub keeps this instance's WebSocket clients and one Redis
  // subscription per watched event. It closes before the server does (preClose), telling
  // clients "going away" so they reconnect to another instance.
  const hub = new LiveSeatHub();
  app.decorate('liveHub', hub);
  app.addHook('preClose', async () => hub.close());
  await app.register(websocket, { options: { maxPayload: 4096 } });

  // Zod schemas handle request validation, response serialization and the OpenAPI spec,
  // so there's one source of truth for all three.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cookie);
  app.decorateRequest('user', null);

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Ticket Management API',
        description:
          'Event ticketing: venues, seat maps, events and bookings.\n\n' +
          'Authenticate with `POST /api/v1/auth/login`, then click **Authorize** and paste the `accessToken`. ' +
          'The refresh token is set as an httpOnly cookie, so `POST /api/v1/auth/refresh` works straight from this page.',
        version: '0.2.0',
      },
      tags: [
        { name: 'auth', description: 'Signup, login, token refresh, sessions and passwords' },
        { name: 'events', description: 'Events, search and seat maps' },
        { name: 'bookings', description: 'Seat holds and bookings' },
        { name: 'payments', description: 'Payments, refunds and provider webhooks' },
        { name: 'tickets', description: 'QR tickets and check-in' },
        { name: 'organizer', description: "The organizer dashboard: your events' numbers and attendees" },
        { name: 'venues', description: 'Venues and their seat layouts' },
        { name: 'users', description: 'Profiles and roles' },
        { name: 'admin', description: 'Queues and dead letters (admin)' },
        { name: 'ops', description: 'Operational endpoints' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
    },
    transform: jsonSchemaTransform,
    transformObject, // turns .meta({ id }) schemas into reusable components
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({
      error: { code: 'ROUTE_NOT_FOUND', message: `Route ${req.method} ${req.url} not found` },
    }),
  );

  // The web pages (seat map, account pages). wildcard: false registers one route per
  // file, so unknown paths still reach our JSON 404 handler.
  await app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    wildcard: false,
    setHeaders: (reply) => {
      reply.header('content-security-policy', STATIC_CSP);
      reply.header('x-content-type-options', 'nosniff');
      reply.header('referrer-policy', 'no-referrer');
    },
  });
  // Pages at clean URLs: /login rather than /login.html, /events/<id> for an event.
  for (const page of PAGES) {
    app.get(`/${page}`, { schema: { hide: true } }, (_req, reply) => reply.sendFile(`${page}.html`));
  }
  app.get('/events/:id', { schema: { hide: true } }, (_req, reply) => reply.sendFile('event.html'));
  app.get('/organizer/events/new', { schema: { hide: true } }, (_req, reply) =>
    reply.sendFile('organizer-new.html'),
  );
  app.get('/organizer/events/:id', { schema: { hide: true } }, (_req, reply) =>
    reply.sendFile('organizer-event.html'),
  );

  await app.register(healthRoutes);
  // The simulated payment provider's browser API (dev and test only; refused in production).
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
      await api.register(organizerRoutes);
      await api.register(adminRoutes);
    },
    { prefix: '/api/v1' },
  );

  return app;
}
