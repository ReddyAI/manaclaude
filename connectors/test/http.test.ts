import { describe, expect, it } from 'vitest';
import { ConnectorRepairNeededError } from '@manaclaude/shared';
import { HttpClient, buildQuery, collectPages, httpRuntime } from '../src/http';
import { ConnectorRateLimitedError, ProviderDataError, ProviderHttpError } from '../src/errors';
import { fakeFetch, makeCtx } from './helpers/fakeFetch';

const client = (routes: Parameters<typeof fakeFetch>[0], opts = {}) => {
  const fetch = fakeFetch(routes);
  return {
    fetch,
    http: new HttpClient(makeCtx({}, fetch), {
      provider: 'Demo',
      baseUrl: 'https://api.demo.test/v1',
      ...opts,
    }),
  };
};

describe('http client', () => {
  it('builds query strings, skipping empty values and repeating arrays', () => {
    expect(buildQuery({ a: 1, b: 'x y', c: undefined, d: null, e: ['1', '2'], f: false })).toBe(
      'a=1&b=x%20y&e=1&e=2&f=false',
    );
    expect(buildQuery(undefined)).toBe('');
  });

  it('sends JSON bodies and form bodies with the right content type', async () => {
    const { http, fetch } = client({
      'POST api.demo.test/v1/a': { json: { ok: true } },
      'POST api.demo.test/v1/b': { json: {} },
    });
    expect(await http.post('/a', { x: 1 })).toEqual({ ok: true });
    await http.request('POST', '/b', { form: { x: 1, y: undefined } });
    expect(fetch.calls[0]).toMatchObject({
      body: '{"x":1}',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(fetch.calls[1]).toMatchObject({
      body: 'x=1',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  });

  it('turns 401 and 403 into a repair error without leaking the body', async () => {
    const { http } = client({
      'GET api.demo.test/v1/a': { status: 401, json: { secret: 'tok_123456' } },
    });
    const error = await http.get('/a').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectorRepairNeededError);
    expect((error as Error).message).not.toContain('tok_123456');
  });

  it('lets an adapter decide which statuses need repair and read repair out of a body', async () => {
    const a = client(
      { 'GET api.demo.test/v1/a': { status: 403, json: {} } },
      { repairStatuses: [401] },
    );
    await expect(a.http.get('/a')).rejects.toBeInstanceOf(ProviderHttpError);
    const b = client(
      { 'GET api.demo.test/v1/a': { status: 400, json: { code: 'EXPIRED' } } },
      {
        needsRepair: (_s: number, body: { code?: string }) =>
          body.code === 'EXPIRED' ? 'session expired' : null,
      },
    );
    await expect(b.http.get('/a')).rejects.toBeInstanceOf(ConnectorRepairNeededError);
  });

  it('retries 5xx and then succeeds', async () => {
    const sleeps: number[] = [];
    const original = httpRuntime.sleep;
    httpRuntime.sleep = async (ms) => void sleeps.push(ms);
    try {
      const { http } = client({
        'GET api.demo.test/v1/a': (_c, n) =>
          n < 3 ? { status: 503, json: {} } : { json: { ok: n } },
      });
      expect(await http.get('/a')).toEqual({ ok: 3 });
      expect(sleeps.length).toBe(2);
    } finally {
      httpRuntime.sleep = original;
    }
  });

  it('gives up after the retries with a short message and the body kept for logs only', async () => {
    const { http } = client({ 'GET api.demo.test/v1/a': { status: 500, text: 'x'.repeat(2000) } });
    const error = (await http.get('/a').catch((e: unknown) => e)) as ProviderHttpError;
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error.message).toBe('Demo request failed (HTTP 500)');
    expect(error.detail.length).toBe(500);
  });

  it('does not retry 501 or ordinary 4xx', async () => {
    const { http, fetch } = client({
      'GET api.demo.test/v1/a': { status: 501, json: {} },
      'GET api.demo.test/v1/b': { status: 404, json: {} },
    });
    await expect(http.get('/a')).rejects.toMatchObject({ status: 501 });
    await expect(http.get('/b')).rejects.toMatchObject({ status: 404 });
    expect(fetch.calls).toHaveLength(2);
  });

  it('reports a rate limit with the Retry-After value, waiting no more than ten seconds between tries', async () => {
    const sleeps: number[] = [];
    const original = httpRuntime.sleep;
    httpRuntime.sleep = async (ms) => void sleeps.push(ms);
    try {
      const { http } = client({
        'GET api.demo.test/v1/a': { status: 429, json: {}, headers: { 'retry-after': '120' } },
      });
      const error = (await http.get('/a').catch((e: unknown) => e)) as ConnectorRateLimitedError;
      expect(error).toBeInstanceOf(ConnectorRateLimitedError);
      expect(error.retryAfterSeconds).toBe(120);
      expect(Math.max(...sleeps)).toBe(10_000);
    } finally {
      httpRuntime.sleep = original;
    }
  });

  it('wraps network failures and non-JSON success bodies', async () => {
    const down = new HttpClient(
      makeCtx({}, (async () => {
        throw new Error('socket hang up');
      }) as never),
      { provider: 'Demo', baseUrl: 'https://x.test', retries: 1 },
    );
    await expect(down.get('/a')).rejects.toMatchObject({ status: 0 });
    const { http } = client({ 'GET api.demo.test/v1/a': { text: '<html>' } });
    await expect(http.get('/a')).rejects.toBeInstanceOf(ProviderDataError);
  });

  it('returns text for XML and nothing for empty bodies', async () => {
    const { http } = client({
      'GET api.demo.test/v1/a': { text: '<a/>' },
      'GET api.demo.test/v1/b': { text: '' },
    });
    expect(await http.get('/a', {}, { text: true })).toBe('<a/>');
    expect(await http.get('/b')).toBeUndefined();
  });

  it('applies a signer to every call', async () => {
    const { http, fetch } = client(
      { 'GET api.demo.test/v1/a': { json: {} } },
      {
        sign: async ({ method, path, query }: { method: string; path: string; query: string }) => ({
          'X-Sig': `${method}|${path}|${query}`,
        }),
      },
    );
    await http.get('/a', { q: 1 });
    expect(fetch.calls[0]?.headers['X-Sig']).toBe('GET|/v1/a|q=1');
  });

  it('collectPages stops on a repeated cursor', async () => {
    const out = await collectPages(
      async (c: string | null) => ({
        items: [c ?? 'first'],
        next: c === null ? 'a' : c === 'a' ? 'b' : 'a',
      }),
      (p) => p.items,
      (p) => p.next,
    );
    expect(out).toEqual(['first', 'a', 'b']);
  });
});
