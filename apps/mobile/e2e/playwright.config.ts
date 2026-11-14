import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';
import type { E2eOptions } from './fixtures';

/**
 * Browser tests for the exported web build against a local Worker.
 *
 * `npm run e2e -w @manaclaude/mobile` exports the web build, starts one local
 * Worker per screen width (each with a fresh database, the invented sample
 * data and a few planted rows), serves the export and runs every spec at
 * 412 px and 1280 px. See e2e/README.md. Nothing here calls a provider, and
 * `npm run check` does not run it.
 */

const portBase = Number(process.env.E2E_PORT_BASE ?? 8790);
const outDir = process.env.E2E_OUT_DIR ?? path.join(os.tmpdir(), 'billionaire-e2e-results');

export const WEB_PORT = portBase;

export default defineConfig<E2eOptions>({
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: path.join(outDir, 'artifacts'),
  globalSetup: './harness/globalSetup.ts',
  // Each width has its own Worker, but tests within a width share it.
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['list'], ['html', { outputFolder: path.join(outDir, 'report'), open: 'never' }]]
    : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${portBase}`,
    trace: 'off',
    screenshot: 'only-on-failure',
    locale: 'en-US',
    timezoneId: 'UTC',
  },
  projects: [
    {
      name: 'phone-412',
      use: {
        viewport: { width: 412, height: 915 },
        hasTouch: true,
        backendPort: portBase + 1,
      },
    },
    {
      name: 'wide-1280',
      use: { viewport: { width: 1280, height: 800 }, backendPort: portBase + 2 },
    },
  ],
});
