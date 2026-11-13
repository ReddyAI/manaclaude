import { defineConfig } from 'vitest/config';

// Deploy/runtime and private recovery tests run in Node so they can use the
// filesystem and independent local stores. Worker tests in test/ run in workerd.
export default defineConfig({
  test: {
    include: ['deploy/test/**/*.test.ts', 'recovery/test/**/*.test.ts'],
    environment: 'node',
  },
});
