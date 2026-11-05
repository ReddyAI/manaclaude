import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { wazirxAdapter } from '../src/adapters/wazirx';
import { fakeFetch, fixture, makeConnection, makeCtx, type FakeCall } from './helpers/fakeFetch';
import {
  expectRepairOnExpiredToken,
  expectRepeatSyncIsQuiet,
  expectSyncShape,
} from './helpers/contract';

const SECRETS = { WAZIRX_API_KEY: 'demo-key', WAZIRX_API_SECRET: 'demo-secret' };
const H = 'api.wazirx.com/sapi/v1';

function routes(over: Record<string, unknown> = {}) {
  return {
    [`GET ${H}/funds`]: { json: fixture('wazirx', 'funds.json') },
    [`GET ${H}/tickers/24hr`]: { json: fixture('wazirx', 'tickers.json') },
    [`GET ${H}/myTrades`]: (call: FakeCall) => ({
      json:
        call.url.searchParams.get('symbol') === 'btcinr'
          ? fixture('wazirx', 'mytrades_btcinr.json')
          : fixture('wazirx', 'mytrades_usdtinr.json'),
    }),
    ...over,
  };
}
const ctxFor = (r = routes()) => makeCtx(SECRETS, fakeFetch(r));

describe('wazirx adapter', () => {
  it('signs signed calls with HMAC-SHA256 over the query string', async () => {
    const fetch = fakeFetch(routes());
    await wazirxAdapter.sync(makeCtx(SECRETS, fetch), makeConnection('wazirx'));
    const call = fetch.calls[0];
    const url = call?.url as URL;
    const signature = url.searchParams.get('signature');
    const unsigned = url.search.slice(1).replace(/&signature=.*$/, '');
    expect(signature).toBe(createHmac('sha256', 'demo-secret').update(unsigned).digest('hex'));
    expect(call?.headers['X-Api-Key']).toBe('demo-key');
    expect(url.searchParams.get('timestamp')).toBe(
      String(new Date('2026-11-05T12:00:00.000Z').getTime()),
    );
  });

  it('builds an INR crypto account: free INR is cash, coins are holdings priced from tickers', async () => {
    const result = await wazirxAdapter.sync(ctxFor(), makeConnection('wazirx'));
    await expectSyncShape(result);
    expect(result.holdings.map((h) => [h.symbol, h.quantity, h.price])).toEqual([
      ['BTC', '0.012', '5700000'],
      ['USDT', '100', '88.5'],
    ]);
    // 0.012 BTC x 57,00,000 + 100 USDT x 88.50 + 15,230.50 INR cash.
    expect(result.accounts[0]).toMatchObject({
      type: 'crypto',
      currency: 'INR',
      balance: 6_840_000 + 885_000 + 1_523_050,
    });
  });

  it('signs trades: buys are cash out, sells cash in', async () => {
    const { activities } = await wazirxAdapter.sync(ctxFor(), makeConnection('wazirx'));
    const byId = new Map(activities.map((a) => [a.externalId, a]));
    expect(byId.get('wx_9001')).toMatchObject({
      type: 'buy',
      amount: -4_800_000,
      quantity: '0.01',
      symbol: 'BTC',
    });
    expect(byId.get('wx_9003')).toMatchObject({ type: 'sell', amount: 1_680_000 });
    expect(byId.get('wx_9100')).toMatchObject({ type: 'buy', amount: -860_000, symbol: 'USDT' });
  });

  it('derives lots from the trade history', async () => {
    const { store } = await expectRepeatSyncIsQuiet(wazirxAdapter, () => ctxFor());
    const btc = store.securities.find((s) => s.symbol === 'BTC');
    const holding = store.holdings.find((h) => h.securityId === btc?.id);
    const lots = store.taxLots.filter((l) => l.holdingId === holding?.id);
    // Bought 0.01 and 0.005, sold 0.003 (FIFO): 0.007 + 0.005 = 0.012 held.
    expect(lots.map((l) => l.quantity)).toEqual(['0.007', '0.005']);
    expect(lots.map((l) => l.costBasis)).toEqual([3_360_000, 2_600_000]);
  });

  it('asks for repair on 401 and on an invalid key code', async () => {
    await expectRepairOnExpiredToken(wazirxAdapter, () =>
      ctxFor(routes({ [`GET ${H}/funds`]: { status: 401, json: {} } })),
    );
    await expectRepairOnExpiredToken(wazirxAdapter, () =>
      ctxFor(
        routes({ [`GET ${H}/funds`]: { status: 400, json: fixture('wazirx', 'error_key.json') } }),
      ),
    );
  });
});
