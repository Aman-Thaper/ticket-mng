import { z } from 'zod';

// Load .env if present. Real environment variables win over the file.
try {
  process.loadEnvFile();
} catch {
  // no .env file, which is fine in CI/production
}

/** z.coerce.boolean() treats "false" as true (non-empty string), so parse explicitly. */
const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** If set, GET /metrics requires "Authorization: Bearer <METRICS_TOKEN>". */
  METRICS_TOKEN: z.string().min(16).optional(),
  /**
   * On SIGTERM, keep serving (while reporting not-ready) this long before closing, so the
   * load balancer has time to notice and stop routing here.
   */
  SHUTDOWN_DRAIN_MS: z.coerce.number().int().min(0).default(0),
  /** Port of the worker's small health/metrics server. */
  WORKER_HTTP_PORT: z.coerce.number().int().positive().default(3100),
  /** Identifies this process in logs and the x-served-by header (defaults to host:pid). */
  INSTANCE_ID: z.string().optional(),
  /**
   * Which proxies may set X-Forwarded-For. Behind Nginx on the same host use "loopback";
   * otherwise the proxy's address/CIDR, or a hop count. Never "true" on the open internet:
   * clients could then fake their IP and dodge per-IP rate limits.
   */
  TRUST_PROXY: z
    .string()
    .default('false')
    .transform((v) => (v === 'true' ? true : v === 'false' ? false : /^\d+$/.test(v) ? Number(v) : v)),
  /** In-process micro-cache TTL for hot, fast-changing reads (seat maps, availability). */
  MICRO_CACHE_TTL_MS: z.coerce.number().int().min(0).default(1_000),
  /** Per-client-IP limit on the whole API: bursts of CAPACITY, sustained REFILL per second. */
  RATE_LIMIT_ENABLED: bool.default(true),
  RATE_LIMIT_IP_CAPACITY: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_IP_REFILL_PER_SEC: z.coerce.number().positive().default(30),
  /** Public base URL of the app, used for links in emails. */
  APP_URL: z.url().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1),
  /**
   * Connections per process. Sum across every process must stay under Postgres'
   * max_connections (100 by default): e.g. 3 API × 20 + 1 worker × 10 + listener ≈ 71.
   */
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  /** How long a request waits for a free pool connection before failing with 503. */
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  /** Postgres cancels any single statement running longer than this. */
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  // ---- auth
  /** HMAC key for access tokens. Generate with `openssl rand -base64 48`. */
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  /** Previous key, still accepted for verification while rotating secrets. */
  JWT_ACCESS_SECRET_PREVIOUS: z.string().min(32).optional(),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  /** Each refresh token lives this long; using it issues a new one (rotation). */
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  /** Hard cap on a login session, however often it is refreshed. */
  SESSION_MAX_DAYS: z.coerce.number().int().min(1).max(365).default(90),
  PASSWORD_RESET_TTL_MINUTES: z.coerce
    .number()
    .int()
    .min(5)
    .max(24 * 60)
    .default(30),
  /** Argon2id cost. Defaults follow OWASP (19 MiB, 2 passes); tests lower them for speed. */
  ARGON2_MEMORY_KIB: z.coerce.number().int().min(1024).default(19_456),
  ARGON2_TIME_COST: z.coerce.number().int().min(1).default(2),
  /** Must be true in production (HTTPS). Browsers drop Secure cookies on plain http://localhost. */
  COOKIE_SECURE: bool.default(false),

  // ---- booking
  /** How long selected seats stay reserved while the buyer pays. */
  HOLD_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(600),
  /**
   * How concurrent holds on the same seat are resolved (see src/modules/bookings/strategies.ts).
   * 'naive' is deliberately broken, kept to demonstrate the race, and is refused in production.
   */
  HOLD_STRATEGY: z.enum(['pessimistic', 'optimistic', 'serializable', 'naive']).default('pessimistic'),
  /** Redis fast-path that turns away concurrent attempts on the same seat before they reach Postgres. */
  CLAIM_GATE_ENABLED: bool.default(true),

  // ---- payments
  /**
   * 'fake' is a built-in simulated payment gateway (Stripe-shaped: payment intents, signed
   * webhooks) so everything runs offline. 'stripe' uses Stripe in test mode.
   */
  PAYMENT_PROVIDER: z.enum(['fake', 'stripe']).default('fake'),
  STRIPE_SECRET_KEY: z.string().startsWith('sk_').optional(),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith('whsec_').optional(),
  FAKE_GATEWAY_WEBHOOK_SECRET: z.string().min(16).default('whsec_fake_gateway_dev_only_secret'),
  /** Where the fake gateway delivers its webhooks. Defaults to this app's webhook endpoint. */
  FAKE_GATEWAY_WEBHOOK_URL: z.url().optional(),
  /** Deliver every fake webhook twice, with random delays (duplicates + out of order). */
  FAKE_GATEWAY_CHAOS: bool.default(false),
  /** Buyers can ask for a refund until this many hours before the event starts. */
  REFUND_CUTOFF_HOURS: z.coerce.number().int().min(0).default(24),

  // ---- tickets
  /**
   * Ed25519 private key seed (32 bytes, base64) that signs ticket QR codes. Scanners only
   * need the public key (GET /api/v1/tickets/public-key), so they can verify tickets but
   * never mint them. Generate with: openssl rand -base64 32
   */
  TICKET_SIGNING_KEY: z
    .string()
    .refine(
      (v) => Buffer.from(v, 'base64').length === 32,
      'TICKET_SIGNING_KEY must be 32 bytes, base64-encoded',
    ),

  // ---- object storage (S3 API: MinIO locally, S3/R2/... in production)
  S3_ENDPOINT: z.url().default('http://localhost:9000'),
  /** Endpoint as seen by browsers (differs from S3_ENDPOINT inside Docker). */
  S3_PUBLIC_URL: z.url().default('http://localhost:9000'),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().default('minioadmin'),
  S3_SECRET_KEY: z.string().default('minioadmin'),
  S3_BUCKET: z.string().default('ticket-media'),
  /** Create the bucket and its public-read policy at startup (dev convenience; use IaC in production). */
  S3_AUTO_CREATE_BUCKET: bool.default(true),
  POSTER_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),

  // ---- background jobs
  /** Prefix for BullMQ keys in Redis. */
  QUEUE_PREFIX: z.string().default('bull'),

  // ---- email
  SMTP_URL: z.string().default('smtp://localhost:1025'),
  MAIL_FROM: z.string().default('Ticket MNG <no-reply@ticket-mng.local>'),
  /** memory: keep sent mail in-process (tests); smtp: deliver via SMTP_URL. */
  MAIL_TRANSPORT: z.enum(['smtp', 'memory']).default('smtp'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:\n' + z.prettifyError(parsed.error));
  process.exit(1);
}

// The secrets committed in .env.example are for local development only.
const COMMITTED_DEV_SECRETS = new Set([
  'dev-only-secret-do-not-use-in-production-0123456789',
  '+mPtSKxHNhPA3r7ZOfCIbAdEMXWeVaymIJBr0hB2x3I=',
]);
if (
  parsed.data.NODE_ENV === 'production' &&
  (COMMITTED_DEV_SECRETS.has(parsed.data.JWT_ACCESS_SECRET) ||
    COMMITTED_DEV_SECRETS.has(parsed.data.TICKET_SIGNING_KEY))
) {
  console.error('Refusing to start: a development secret from .env.example is configured in production');
  process.exit(1);
}

if (
  parsed.data.PAYMENT_PROVIDER === 'stripe' &&
  (!parsed.data.STRIPE_SECRET_KEY || !parsed.data.STRIPE_WEBHOOK_SECRET)
) {
  console.error('PAYMENT_PROVIDER=stripe needs STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET');
  process.exit(1);
}
if (parsed.data.NODE_ENV === 'production' && parsed.data.PAYMENT_PROVIDER === 'fake') {
  console.error('The fake payment gateway accepts any test card; it is not allowed in production');
  process.exit(1);
}

if (parsed.data.NODE_ENV === 'production' && parsed.data.HOLD_STRATEGY === 'naive') {
  console.error('HOLD_STRATEGY=naive double-books seats by design and is not allowed in production');
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
