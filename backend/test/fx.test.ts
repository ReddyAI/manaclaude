import { beforeEach, describe, expect, it } from 'vitest';
import { convertWithPolicy, findRate, type FxRate } from '@manaclaude/shared';
import oxrLatest from './fixtures/fx/oxr-latest.json';
import frankLatest from './fixtures/fx/frankfurter-latest.json';
import frankSeries from './fixtures/fx/frankfurter-timeseries.json';
import {
  backfillFrankfurter,
  fetchFrankfurterLatest,
  fetchOpenExchangeRates,
  latestRate,
  loadRates,
} from '../src/fx/service';
import {
  createScheduledController,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { createWorker } from '../src/worker';
import { addAccount, freshDb, testEnv } from './helpers';
import { client } from './worker';

/** A fetch that serves the saved provider responses and records the URLs. */
function fakeFetch() {
  const urls: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.startsWith('https://openexchangerates.org/api/latest.json'))
      return Response.json(oxrLatest);
    if (url.startsWith('https://api.frankfurter.dev/v1/latest')) return Response.json(frankLatest);
    if (/api\.frankfurter\.dev\/v1\/\d{4}-\d{2}-\d{2}\.\./.test(url))
      return Response.json(frankSeries);
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { f, urls };
}

beforeEach(freshDb);

describe('FX rates', () => {
  it('stores the hourly Open Exchange Rates fetch with its timestamp, only for the currencies we use', async () => {
    const { f, urls } = fakeFetch();
    await addAccount({ type: 'savings', currency: 'INR', subtype: 'nre' });
    const env = { ...testEnv, OXR_APP_ID: 'sample-app-id' };
    const stored = await fetchOpenExchangeRates(env, f);
    expect(urls[0]).toBe('https://openexchangerates.org/api/latest.json?app_id=sample-app-id');
    const rates = await loadRates(testEnv.DB);
    expect(stored).toBe(rates.length);
    expect(rates.find((r) => r.quote === 'ZAR')).toBeUndefined();
    expect(rates.find((r) => r.quote === 'INR')).toEqual({
      base: 'USD',
      quote: 'INR',
      rate: 88.42,
      asOf: '2026-11-05T14:00:00.000Z',
      date: '2026-11-05',
      source: 'openexchangerates',
    });
    // A second fetch the same day replaces the day's row instead of adding one.
    await fetchOpenExchangeRates(env, f);
    expect((await loadRates(testEnv.DB)).filter((r) => r.quote === 'INR')).toHaveLength(1);
  });

  it('does nothing without the OXR_APP_ID secret', async () => {
    const { f, urls } = fakeFetch();
    expect(await fetchOpenExchangeRates({ ...testEnv, OXR_APP_ID: undefined }, f)).toBe(0);
    expect(urls).toEqual([]);
  });

  it('stores daily ECB rates from Frankfurter and backfills history', async () => {
    const { f, urls } = fakeFetch();
    await fetchFrankfurterLatest(testEnv, f);
    expect(urls[0]).toMatch(/^https:\/\/api\.frankfurter\.dev\/v1\/latest\?base=USD&symbols=/);
    const n = await backfillFrankfurter(testEnv, '2026-10-13', '2026-10-17', f);
    expect(n).toBe(10);
    const rates = await loadRates(testEnv.DB);
    const oct15 = rates.find((r) => r.date === '2026-10-15' && r.quote === 'INR');
    expect(oct15).toMatchObject({
      rate: 88.0,
      source: 'frankfurter_ecb',
      asOf: '2026-10-15T15:00:00.000Z',
    });
  });

  it('latest rate prefers the hourly OXR rate and falls back to ECB', async () => {
    const { f } = fakeFetch();
    await fetchFrankfurterLatest(testEnv, f);
    expect((await latestRate(testEnv.DB, 'USD', 'INR'))?.source).toBe('frankfurter_ecb');
    await fetchOpenExchangeRates({ ...testEnv, OXR_APP_ID: 'x' }, f);
    const r = await latestRate(testEnv.DB, 'USD', 'INR');
    expect(r).toMatchObject({ rate: 88.42, source: 'openexchangerates' });
    const res = await client().api<{ rate: number; asOf: string }>(
      'GET',
      '/v1/fx/latest?base=INR&quote=USD',
    );
    expect(res.body.rate).toBeCloseTo(1 / 88.42, 10);
    expect(res.body.asOf).toBe('2026-11-05T14:00:00.000Z');
  });

  it('conversion policy: balances use the latest rate, reports the day rate, linked transfers their own rate', async () => {
    const { f } = fakeFetch();
    await backfillFrankfurter(testEnv, '2026-10-13', '2026-10-17', f);
    await fetchOpenExchangeRates({ ...testEnv, OXR_APP_ID: 'x' }, f);
    const rates: FxRate[] = await loadRates(testEnv.DB);
    expect(convertWithPolicy(100_000, 'USD', 'INR', rates, { mode: 'latest' })).toBe(8_842_000);
    expect(
      convertWithPolicy(100_000, 'USD', 'INR', rates, { mode: 'on', date: '2026-10-15' }),
    ).toBe(8_800_000);
    const link = {
      id: 'l',
      outTransactionId: 'a',
      inTransactionId: 'b',
      outAmount: 200_000,
      outCurrency: 'USD',
      inAmount: 17_624_000,
      inCurrency: 'INR',
      impliedRate: 88.12,
      status: 'auto' as const,
      kind: 'transfer' as const,
      matchScore: 1,
      matchedBy: 'matcher' as const,
      createdAt: '',
      updatedAt: '',
    };
    expect(
      convertWithPolicy(200_000, 'USD', 'INR', rates, { mode: 'on', date: '2026-10-15' }, link),
    ).toBe(17_624_000);
    expect(findRate(rates, 'EUR', 'INR', { mode: 'on', date: '2026-10-15' })?.rate).toBeCloseTo(
      88.0 / 0.917,
      8,
    );
  });

  it('the hourly cron fetches OXR and the daily cron fetches ECB rates', async () => {
    const { f, urls } = fakeFetch();
    const worker = createWorker({ fetch: f });
    const env = { ...testEnv, OXR_APP_ID: 'x' };
    let ctx = createExecutionContext();
    await worker.scheduled(
      createScheduledController({
        cron: '0 * * * *',
        scheduledTime: Date.parse('2026-11-05T14:00:00Z'),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(urls.some((u) => u.includes('openexchangerates'))).toBe(true);
    ctx = createExecutionContext();
    await worker.scheduled(
      createScheduledController({
        cron: '30 6 * * *',
        scheduledTime: Date.parse('2026-11-05T06:30:00Z'),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(urls.some((u) => u.includes('frankfurter.dev/v1/latest'))).toBe(true);
  });
});
