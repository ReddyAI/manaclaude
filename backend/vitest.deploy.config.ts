import { defineConfig } from 'vitest/config';

// Tests for the deploy scripts in deploy/. They run in plain Node (the Worker
// tests in test/ run inside workerd) because they read files and the workflow.
export default defineConfig({
  test: { include: ['deploy/test/**/*.test.ts'], environment: 'node' },
});
