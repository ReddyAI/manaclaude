import { describe, expect, it } from 'vitest';
import { cleanTrading212Ticker, trading212Adapter } from '../src/adapters/trading212';
import { fakeFetch, fixture, makeConnection, makeCtx, type FakeCall } from './helpers/fakeFetch';
import {
  expectRepairOnExpiredToken,
  expectRepeatSyncIsQuiet,
  expectSyncShape,
} from './helpers/contract';

const SECRETS = { T212_API_KEY: 'demo-key', T212_API_SECRET: 'demo-secret' };
const H = 'live.trading212.com/api/v0';

function routes(over: Record<string, unknown> = {}) {
  return {
    [`GET ${H}/equity/account/summary`]: { json: fixture('trading212', 'summary.json') },
    [`GET ${H}/equity/positions`]: { json: fixture('trading212', 'positions.json') },
    [`GET ${H}/equity/history/orders`]: (call: FakeCall) => ({
      json: call.url.searchParams.get('cursor')
        ? fixture('trading212', 'orders_page2.json')
        : fixture('trading212', 'orders_page1.json'),
    }),
    [`GET ${H}/equity/history/dividends`]: { json: fixture('trading212', 'dividends.json') },
    [`GET ${H}/equity/history/transactions`]: { json: fixture('trading212', 'transactions.json') },
    ...over,
  };
}
const ctxFor = (r = routes()) => makeCtx(SECRETS, fakeFetch(r));

describe('trading 212 adapter', () => {
  it('cleans tickers', () => {
    expect(cleanTrading212Ticker('AAPL_US_EQ')).toBe('AAPL');
    expect(cleanTrading212Ticker('VUSAl_EQ')).toBe('VUSA');
  });

  it('sends basic auth', async () => {
    const fetch = fakeFetch(routes());
    await trading212Adapter.sync(makeCtx(SECRETS, fetch), makeConnection('trading212'));
    expect(atob((fetch.calls[0]?.headers.Authorization ?? '').replace('Basic ', ''))).toBe(
      'demo-key:demo-secret',
    );
  });

  it('maps the account from the summary and converts pence (GBX) to pounds', async () => {
    const result = await trading212Adapter.sync(ctxFor(), makeConnection('trading212'));
    await expectSyncShape(result);
    expect(result.accounts[0]).toMatchObject({
      externalId: '40123456',
      currency: 'GBP',
      balance: 425_075,
    });
    const vusa = result.holdings.find((h) => h.symbol === 'VUSA');
    expect(vusa).toMatchObject({
      price: '98.5',
      currency: 'GBP',
      quantity: '20',
      costBasis: 160_000,
    });
    expect(result.holdings.find((h) => h.symbol === 'AAPL')).toMatchObject({
      currency: 'USD',
      costBasis: 150_000,
      exchange: 'NASDAQ',
    });
  });

  it('follows nextPagePath, keeps only FILLED orders, and signs cash by side', async () => {
    const fetch = fakeFetch(routes());
    const { activities } = await trading212Adapter.sync(
      makeCtx(SECRETS, fetch),
      makeConnection('trading212'),
    );
    const orderCalls = fetch.calls.filter((c) => c.url.pathname.endsWith('/history/orders'));
    expect(orderCalls.map((c) => c.url.searchParams.get('cursor'))).toEqual([null, '1002']);
    const byId = new Map(activities.map((a) => [a.externalId, a]));
    expect(byId.get('t212_5001')).toMatchObject({
      type: 'buy',
      amount: -119_050,
      currency: 'GBP',
      symbol: 'AAPL',
      price: '150',
    });
    expect(byId.get('t212_5002')).toMatchObject({ type: 'sell', amount: 43_000, price: '86' });
    expect(byId.get('t212_4999')).toMatchObject({ type: 'buy', amount: -200_000 });
    expect(byId.size).toBe(3 + 1 + 3);
    expect(byId.get('t212_div_div-2001')).toMatchObject({ type: 'dividend', amount: 190 });
    expect(byId.get('t212_tx_tx-3001')).toMatchObject({ type: 'contribution', amount: 100_000 });
    expect(byId.get('t212_tx_tx-3002')).toMatchObject({ type: 'withdrawal', amount: -5_000 });
    expect(byId.get('t212_tx_tx-3003')).toMatchObject({ type: 'fee', amount: -50 });
  });

  it('derives lots; history shorter than the position becomes an opening lot', async () => {
    const { store } = await expectRepeatSyncIsQuiet(trading212Adapter, () => ctxFor());
    const vusa = store.securities.find((s) => s.symbol === 'VUSA');
    const lots = store.taxLots.filter(
      (l) => l.holdingId === store.holdings.find((h) => h.securityId === vusa?.id)?.id,
    );
    // Bought 25, sold 5 = 20 held; the history explains all 20.
    expect(lots.map((l) => [l.acquiredOn, l.quantity])).toEqual([['2025-12-01', '20']]);
    const aapl = store.securities.find((s) => s.symbol === 'AAPL');
    expect(
      store.taxLots.filter(
        (l) => l.holdingId === store.holdings.find((h) => h.securityId === aapl?.id)?.id,
      )[0],
    ).toMatchObject({ quantity: '10', costBasis: 119_050 });
  });

  it('keeps what it read when history is rate limited', async () => {
    const r = routes({
      [`GET ${H}/equity/history/orders`]: (call: FakeCall) =>
        call.url.searchParams.get('cursor')
          ? { status: 429, json: {}, headers: { 'retry-after': '10' } }
          : { json: fixture('trading212', 'orders_page1.json') },
    });
    const { activities } = await trading212Adapter.sync(ctxFor(r), makeConnection('trading212'));
    expect(activities.filter((a) => a.type === 'buy' || a.type === 'sell')).toHaveLength(2);
  });

  it('asks for repair when the key is rejected', async () => {
    await expectRepairOnExpiredToken(trading212Adapter, () =>
      ctxFor(routes({ [`GET ${H}/equity/account/summary`]: { status: 401, json: {} } })),
    );
  });
});
