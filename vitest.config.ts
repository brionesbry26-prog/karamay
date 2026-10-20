import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 20000,
    hookTimeout: 30000,
    // Files share one Postgres database; each file uses its own Redis key prefix.
    fileParallelism: true,
  },
});
