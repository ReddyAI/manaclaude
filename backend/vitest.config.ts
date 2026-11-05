import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Tests run inside workerd with a local D1 database, R2 bucket and KV
// namespace (Miniflare). Nothing calls the network: providers get saved
// responses from test/fixtures through injected fetch and AI fakes.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.toml' },
        remoteBindings: false,
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            APP_API_TOKEN: 'test-app-token',
            MCP_OWNER_PASSWORD: 'test-owner-password',
            ALLOW_SAMPLE_SEED: 'true',
          },
        },
      }),
    ],
    test: { include: ['test/**/*.test.ts'] },
  };
});
