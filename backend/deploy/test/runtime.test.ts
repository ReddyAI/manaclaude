import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createTestHarness, unstable_readConfig as readConfig } from 'wrangler';

describe('production Worker entry', () => {
  it('boots the configured entry and serves health with API authentication enforced', async () => {
    const config = readConfig({
      config: fileURLToPath(new URL('../../wrangler.toml', import.meta.url)),
    });
    const server = createTestHarness({
      workers: [
        {
          // Use the real entry and compatibility settings, with local bindings only.
          // Workers AI would require a remote session even before a request uses it.
          config: {
            name: config.name,
            main: config.main,
            compatibility_date: config.compatibility_date,
            compatibility_flags: config.compatibility_flags,
            vars: { ...config.vars, APP_API_TOKEN: 'invented-runtime-test-token' },
            d1_databases: config.d1_databases,
            r2_buckets: config.r2_buckets,
            kv_namespaces: config.kv_namespaces,
          },
        },
      ],
    });
    try {
      await server.listen();
      const health = await server.fetch('/health');
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ ok: true });
      expect((await server.fetch('/v1/dataset')).status).toBe(401);
    } finally {
      await server.close();
    }
  }, 60_000);
});
