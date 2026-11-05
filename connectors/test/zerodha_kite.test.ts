import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { exchangeKiteRequestToken, zerodhaKiteAdapter } from '../src/adapters/zerodha_kite';
import { fakeFetch, fixture, makeConnection, makeCtx } from './helpers/fakeFetch';
import {
  expectRepairOnExpiredToken,
  expectRepeatSyncIsQuiet,
  expectSyncShape,
} from './helpers/contract';
import { MemoryStore } from './helpers/store';

const SECRETS = {
  KITE_API_KEY: 'demo_key',
  KITE_API_SECRET: 'demo_secret',
  KITE_ACCESS_TOKEN: 'demo_token',
};
const H = 'api.kite.trade';

function routes(over: Record<string, unknown> = {}) {
  return {
    [`GET ${H}/user/profile`]: { json: fixture('zerodha_kite', 'profile.json') },
    [`GET ${H}/portfolio/holdings`]: { json: fixture('zerodha_kite', 'holdings.json') },
    [`GET ${H}/user/margins`]: { json: fixture('zerodha_kite', 'margins.json') },
    [`GET ${H}/trades`]: { json: fixture('zerodha_kite', 'trades.json') },
    ...over,
  };
}
const ctxFor = (r = routes()) => makeCtx(SECRETS, fakeFetch(r));

describe('zerodha kite adapter', () => {
  it('sends the token header and version', async () => {
    const fetch = fakeFetch(routes());
    await zerodhaKiteAdapter.sync(makeCtx(SECRETS, fetch), makeConnection('zerodha_kite'));
    expect(fetch.calls[0]?.headers.Authorization).toBe('token demo_key:demo_token');
    expect(fetch.calls[0]?.headers['X-Kite-Version']).toBe('3');
  });

  it('maps a demat account in INR with holdings, NSE and BSE exchanges, and settling units', async () => {
    const result = await zerodhaKiteAdapter.sync(ctxFor(), makeConnection('zerodha_kite'));
    await expectSyncShape(result);
    const reliance = result.holdings.find((h) => h.symbol === 'RELIANCE');
    // 10 settled + 2 in T+1 = 12 units; cost basis 12 x 2400.50 = 28,806.00 INR.
    expect(reliance).toMatchObject({
      quantity: '12',
      price: '2510.75',
      exchange: 'NSE',
      currency: 'INR',
      costBasis: 2_880_600,
    });
    expect(result.holdings.map((h) => h.symbol)).toEqual(['RELIANCE', 'GOLDBEES']); // zero-quantity row skipped
    expect(result.holdings.find((h) => h.symbol === 'GOLDBEES')?.securityType).toBe('etf');
    // Balance: 12 x 2510.75 + 100 x 72.4 + 25,000 cash.
    expect(result.accounts[0]).toMatchObject({
      type: 'brokerage',
      subtype: 'demat',
      currency: 'INR',
      balance: 3_012_900 + 724_000 + 2_500_000,
    });
  });

  it("turns today's fills into activities with trade ids", async () => {
    const { activities } = await zerodhaKiteAdapter.sync(ctxFor(), makeConnection('zerodha_kite'));
    expect(activities).toHaveLength(2);
    expect(activities[0]).toMatchObject({
      externalId: '10000001',
      type: 'buy',
      amount: -499_000,
      date: '2026-11-05',
    });
    expect(activities[1]).toMatchObject({ externalId: '10000002', type: 'sell', amount: 72_100 });
  });

  it("records the position as an opening lot at Zerodha's cost and stays quiet on repeat syncs", async () => {
    const { store } = await expectRepeatSyncIsQuiet(zerodhaKiteAdapter, () => ctxFor());
    const reliance = store.securities.find((s) => s.symbol === 'RELIANCE');
    const holding = store.holdings.find((h) => h.securityId === reliance?.id);
    const lots = store.taxLots.filter((l) => l.holdingId === holding?.id);
    // The BUY of 2 today is derived; the other 10 units are the opening lot.
    expect(lots.reduce((n, l) => n + Number(l.quantity), 0)).toBe(12);
    expect(lots.reduce((n, l) => n + l.costBasis, 0)).toBe(2_880_600);
    expect(reliance?.assetClass).toBe('india_stocks');
  });

  it('keeps the opening lot date stable as days pass', async () => {
    const store = new MemoryStore();
    const conn = makeConnection('zerodha_kite');
    store.apply(conn, await zerodhaKiteAdapter.sync(ctxFor(), conn), '2026-11-05T12:00:00.000Z');
    const first = store.taxLots.map((l) => [l.id, l.acquiredOn]);
    store.apply(conn, await zerodhaKiteAdapter.sync(ctxFor(), conn), '2026-11-06T12:00:00.000Z');
    expect(store.taxLots.map((l) => [l.id, l.acquiredOn])).toEqual(first);
  });

  it('asks for repair when the daily token has expired', async () => {
    await expectRepairOnExpiredToken(zerodhaKiteAdapter, () =>
      ctxFor(
        routes({
          [`GET ${H}/user/profile`]: {
            status: 403,
            json: fixture('zerodha_kite', 'error_token.json'),
          },
        }),
      ),
    );
  });

  it('exchanges a request token with the documented checksum', async () => {
    const fetch = fakeFetch({
      [`POST ${H}/session/token`]: { json: fixture('zerodha_kite', 'session_token.json') },
    });
    const token = await exchangeKiteRequestToken(makeCtx(SECRETS, fetch), 'req123');
    expect(token).toBe('demo-access-token-next-day');
    const form = new URLSearchParams(fetch.calls[0]?.body ?? '');
    expect(form.get('checksum')).toBe(
      createHash('sha256').update('demo_keyreq123demo_secret').digest('hex'),
    );
    expect(form.get('request_token')).toBe('req123');
  });
});
