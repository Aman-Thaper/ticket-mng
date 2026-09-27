import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: { name: 'unit', include: ['test/unit/**/*.test.ts'] },
      },
      {
        test: {
          name: 'api',
          include: ['test/api/**/*.test.ts'],
          globalSetup: ['test/global-setup.ts'],
          setupFiles: ['test/setup-env.ts'],
          // API tests share one database, so test files run one at a time.
          fileParallelism: false,
          // Real Postgres/Redis round trips: generous limits so a busy machine doesn't cause flakes.
          testTimeout: 20_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
