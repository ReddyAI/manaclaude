import { describe, expect, it } from 'vitest';
import { coinstatsAdapter } from '../src/adapters/coinstats';
import { fakeFetch, fixture, makeConnection, makeCtx, type FakeCall } from './helpers/fakeFetch';
import {
  expectRepairOnExpiredToken,
  expectRepeatSyncIsQuiet,
  expectSyncShape,
} from './helpers/contract';

const SECRETS = {
  COINSTATS_API_KEY: 'demo-cstats-key',
  COINSTATS_PORTFOLIO_ID: 'pf-demo-1',
  COINSTATS_PAGE_SIZE: '2',
};
const H = 'openapiv1.coinstats.app';

const pageOf = (call: FakeCall) => call.url.searchParams.get('page');
const routes = (over: Record<string, unknown> = {}) => ({
  [`GET ${H}/portfolio/coins`]: (call: FakeCall) => ({
    json:
      pageOf(call) === '1'
        ? fixture('coinstats', 'coins_page1.json')
        : fixture('coinstats', 'coins_page2.json'),
  }),
  [`GET ${H}/portfolio/transactions`]: (call: FakeCall) => ({
    json:
      pageOf(call) === '1'
        ? fixture('coinstats', 'transactions_page1.json')
        : fixture('coinstats', 'transactions_page2.json'),
  }),
  [`GET ${H}/wallet/blockchains`]: { json: [] },
  ...over,
});
const ctxFor = (r = routes()) => makeCtx(SECRETS, fakeFetch(r));

describe('coinstats adapter', () => {
  it('pages coins and transactions, sends the key header and the portfolio id', async () => {
    const fetch = fakeFetch(routes());
    const result = await coinstatsAdapter.sync(
      makeCtx(SECRETS, fetch),
      makeConnection('coinstats'),
    );
    await expectSyncShape(result);
    expect(fetch.calls[0]?.headers['X-API-KEY']).toBe('demo-cstats-key');
    expect(fetch.calls[0]?.url.searchParams.get('portfolioId')).toBe('pf-demo-1');
    const pages = fetch.calls
      .filter((c) => c.url.pathname === '/portfolio/coins')
      .map((c) => c.url.searchParams.get('page'));
    expect(pages).toEqual(['1', '2']);
    expect(result.holdings.map((h) => h.symbol)).toEqual(['BTC', 'ETH']);
  });

  it('values the account from totalWorth plus fiat cash', async () => {
    const { accounts } = await coinstatsAdapter.sync(ctxFor(), makeConnection('coinstats'));
    expect(accounts[0]).toMatchObject({
      type: 'crypto',
      currency: 'USD',
      balance: 340_001 + 294_030 + 50_025,
    });
  });

  it('turns transactions into signed activities', async () => {
    const { activities } = await coinstatsAdapter.sync(ctxFor(), makeConnection('coinstats'));
    const byId = new Map(activities.map((a) => [a.externalId, a]));
    expect(byId.get('cstats_cstx-1')).toMatchObject({
      type: 'buy',
      amount: -123_650,
      quantity: '0.02',
      symbol: 'BTC',
    });
    expect(byId.get('cstats_cstx-2')).toMatchObject({
      type: 'sell',
      amount: 70_000,
      quantity: '0.01',
    });
    expect(byId.get('cstats_cstx-3')).toMatchObject({
      type: 'transfer_in',
      amount: 0,
      quantity: '1.2',
    });
  });

  it('derives lots and is quiet on a repeat sync', async () => {
    const { store } = await expectRepeatSyncIsQuiet(coinstatsAdapter, () => ctxFor());
    const eth = store.securities.find((s) => s.symbol === 'ETH');
    const lots = store.taxLots.filter(
      (l) => l.holdingId === store.holdings.find((h) => h.securityId === eth?.id)?.id,
    );
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({ quantity: '1.2', acquiredOn: '2026-02-20' });
  });

  it('asks for repair when the key is rejected', async () => {
    await expectRepairOnExpiredToken(coinstatsAdapter, () =>
      ctxFor(
        routes({
          [`GET ${H}/portfolio/coins`]: { status: 401, json: { message: 'Invalid API key' } },
        }),
      ),
    );
  });
});
