import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { binanceAdapter } from '../src/adapters/binance';
import { fakeFetch, fixture, makeConnection, makeCtx, type FakeCall } from './helpers/fakeFetch';
import {
  expectRepairOnExpiredToken,
  expectRepeatSyncIsQuiet,
  expectSyncShape,
} from './helpers/contract';

const SECRETS = { BINANCE_API_KEY: 'demo-binance-key', BINANCE_API_SECRET: 'demo-binance-secret' };
const H = 'api.binance.com/api/v3';

function routes(over: Record<string, unknown> = {}) {
  return {
    [`GET ${H}/account`]: { json: fixture('binance', 'account.json') },
    [`GET ${H}/ticker/price`]: { json: fixture('binance', 'prices.json') },
    [`GET ${H}/myTrades`]: (call: FakeCall) => ({
      json:
        call.url.searchParams.get('symbol') === 'BTCUSDT'
          ? fixture('binance', 'mytrades_btc.json')
          : fixture('binance', 'mytrades_eth.json'),
    }),
    ...over,
  };
}
const ctxFor = (r = routes()) => makeCtx(SECRETS, fakeFetch(r));

describe('binance adapter', () => {
  it('sends the key header and a hex HMAC-SHA256 signature of the query', async () => {
    const fetch = fakeFetch(routes());
    await binanceAdapter.sync(makeCtx(SECRETS, fetch), makeConnection('binance'));
    const call = fetch.calls[0] as FakeCall;
    expect(call.headers['X-MBX-APIKEY']).toBe('demo-binance-key');
    const query = call.url.search.slice(1);
    const unsigned = query.replace(/&signature=.*$/, '');
    expect(call.url.searchParams.get('signature')).toBe(
      createHmac('sha256', 'demo-binance-secret').update(unsigned).digest('hex'),
    );
    expect(call.url.searchParams.get('recvWindow')).toBe('5000');
  });

  it('values holdings in USD, counts stablecoins as cash and skips unpriced assets', async () => {
    const result = await binanceAdapter.sync(ctxFor(), makeConnection('binance'));
    await expectSyncShape(result);
    expect(result.holdings.map((h) => [h.symbol, h.quantity, h.price])).toEqual([
      ['BTC', '0.06', '68000.1'],
      ['ETH', '1.2', '2450.25'],
    ]);
    expect(result.accounts[0]).toMatchObject({
      type: 'crypto',
      currency: 'USD',
      balance: 408_001 + 294_030 + 15_050,
    });
  });

  it('signs trades; a fee paid in the bought coin is not added to the cash cost', async () => {
    const { activities } = await binanceAdapter.sync(ctxFor(), makeConnection('binance'));
    const byId = new Map(activities.map((a) => [a.externalId, a]));
    expect(byId.get('bn_BTCUSDT_1001')).toMatchObject({ type: 'buy', amount: -122_122, fees: 122 });
    expect(byId.get('bn_BTCUSDT_1002')).toMatchObject({ type: 'buy', amount: -264_000, fees: 0 });
    expect(byId.get('bn_BTCUSDT_1003')).toMatchObject({ type: 'sell', amount: 69_930, fees: 70 });
    expect(byId.get('bn_ETHUSDT_2001')).toMatchObject({ type: 'buy', amount: -288_288 });
  });

  it('derives lots and stays quiet on a repeat sync', async () => {
    const { store } = await expectRepeatSyncIsQuiet(binanceAdapter, () => ctxFor());
    const btc = store.securities.find((s) => s.symbol === 'BTC');
    const lots = store.taxLots.filter(
      (l) => l.holdingId === store.holdings.find((h) => h.securityId === btc?.id)?.id,
    );
    expect(lots.map((l) => l.quantity)).toEqual(['0.01', '0.04', '0.01']); // 0.02 - 0.01 sold, 0.04, opening 0.01 (the locked part)
  });

  it('asks for repair on 401 and on error code -2015', async () => {
    await expectRepairOnExpiredToken(binanceAdapter, () =>
      ctxFor(
        routes({
          [`GET ${H}/account`]: { status: 401, json: fixture('binance', 'error_key.json') },
        }),
      ),
    );
    await expectRepairOnExpiredToken(binanceAdapter, () =>
      ctxFor(
        routes({
          [`GET ${H}/account`]: { status: 400, json: fixture('binance', 'error_key.json') },
        }),
      ),
    );
  });

  it('can point at Binance.US', async () => {
    const fetch = fakeFetch({
      'GET api.binance.us/api/v3/account': { json: { balances: [] } },
      'GET api.binance.us/api/v3/ticker/price': { json: [] },
    });
    await binanceAdapter.sync(
      makeCtx({ ...SECRETS, BINANCE_BASE_URL: 'https://api.binance.us' }, fetch),
      makeConnection('binance'),
    );
    expect(fetch.calls[0]?.url.host).toBe('api.binance.us');
  });
});
