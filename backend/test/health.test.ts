import { beforeEach, describe, expect, it } from 'vitest';
import { freshDb } from './helpers';
import { client } from './worker';

describe('worker', () => {
  beforeEach(freshDb);

  it('answers /health without a token', async () => {
    const res = await client().api<{ ok: boolean; policies: { cardPayments: string } }>(
      'GET',
      '/health',
      undefined,
      null,
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.policies.cardPayments).toBe('exclude');
  });

  it('returns 404 for unknown paths', async () => {
    const res = await client().api('GET', '/v1/nope');
    expect(res.status).toBe(404);
  });

  it('refuses /v1 without the right token', async () => {
    expect((await client().api('GET', '/v1/accounts', undefined, null)).status).toBe(401);
    expect((await client().api('GET', '/v1/accounts', undefined, 'wrong')).status).toBe(401);
    expect((await client().api('GET', '/v1/accounts')).status).toBe(200);
  });

  it('fails closed when APP_API_TOKEN is not set', async () => {
    const { testEnv } = await import('./helpers');
    const res = await client({}, { ...testEnv, APP_API_TOKEN: undefined }).api(
      'GET',
      '/v1/accounts',
    );
    expect(res.status).toBe(503);
  });
});
