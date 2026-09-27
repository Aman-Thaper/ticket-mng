// Runs before each test file. It points the app at the test database before
// src/config.ts is imported. Real env vars win over .env, so this override sticks.
try {
  process.loadEnvFile();
} catch {}

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set (see .env.example)');

// Tests truncate every table, so refuse anything that doesn't look like a throwaway database.
const dbName = new URL(url).pathname.slice(1);
if (!/test/i.test(dbName)) {
  throw new Error(`Refusing to run tests against database "${dbName}": its name must contain "test"`);
}

process.env.DATABASE_URL = url;
process.env.NODE_ENV = 'test';
