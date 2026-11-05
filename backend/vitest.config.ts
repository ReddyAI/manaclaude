import { defineConfig } from 'vitest/config';

// Plain Node for now. Session B switches to @cloudflare/vitest-pool-workers
// to test against a local D1 database.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
