// Runs before each test file (and once in global setup). It points the app at the test
// database and Redis before src/config.ts is imported. Real env vars win over .env, so
// these overrides stick.
try {
  process.loadEnvFile();
} catch {
  // no .env file (CI sets real env vars)
}

const dbUrl = process.env.TEST_DATABASE_URL;
if (!dbUrl) throw new Error('TEST_DATABASE_URL is not set (see .env.example)');
const redisUrl = process.env.TEST_REDIS_URL;
if (!redisUrl) throw new Error('TEST_REDIS_URL is not set (see .env.example)');

// Tests wipe everything, so refuse anything that doesn't look like a throwaway target.
const dbName = new URL(dbUrl).pathname.slice(1);
if (!/test/i.test(dbName)) {
  throw new Error(`Refusing to run tests against database "${dbName}": its name must contain "test"`);
}
const redisDb = Number(new URL(redisUrl).pathname.slice(1) || 0);
if (redisDb === 0) {
  throw new Error(
    'Refusing to run tests against Redis DB 0: set TEST_REDIS_URL to e.g. redis://localhost:6379/15',
  );
}

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: dbUrl,
  REDIS_URL: redisUrl,
  MAIL_TRANSPORT: 'memory',
  // Every inject() comes from 127.0.0.1: a per-IP limit would throttle the suite itself.
  // (test/api/scaling.test.ts turns it on explicitly.)
  RATE_LIMIT_ENABLED: 'false',
  // Tests read right after writing; the 1 s micro-caches would serve the previous state.
  MICRO_CACHE_TTL_MS: '0',
  // Tests upload and resize real images in MinIO, in their own bucket.
  S3_BUCKET: process.env.TEST_S3_BUCKET ?? 'ticket-media-test',
  // Minimum argon2 cost: the hashing itself isn't under test, and OWASP parameters would
  // make every signup/login in the suite take ~25 ms.
  ARGON2_MEMORY_KIB: '1024',
  ARGON2_TIME_COST: '1',
});
