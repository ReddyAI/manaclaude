import { describe, expect, it } from 'vitest';
import { indexaAdapter } from '../src/adapters/indexa';
import { fakeFetch, fixture, makeConnection, makeCtx } from './helpers/fakeFetch';
import {
  expectRepairOnExpiredToken,
  expectRepeatSyncIsQuiet,
  expectSyncShape,
} from './helpers/contract';

const SECRETS = { INDEXA_API_TOKEN: 'demo-indexa-token' };
const H = 'api.indexacapital.com';

function routes(over: Record<string, unknown> = {}) {
  return {
    [`GET ${H}/users/me`]: { json: fixture('indexa', 'users_me.json') },
    [`GET ${H}/accounts/ABCD1234/performance`]: {
      json: fixture('indexa', 'performance_mutual.json'),
    },
    [`GET ${H}/accounts/PENS5678/performance`]: {
      json: fixture('indexa', 'performance_pension.json'),
    },
    [`GET ${H}/accounts/ABCD1234/fiscal-results`]: {
      json: fixture('indexa', 'fiscal_mutual.json'),
    },
    [`GET ${H}/accounts/PENS5678/fiscal-results`]: { json: fixture('indexa', 'fiscal_empty.json') },
    [`GET ${H}/accounts/PENS5678/portfolio`]: { json: fixture('indexa', 'portfolio_pension.json') },
    ...over,
  };
}
const ctxFor = (r = routes()) => makeCtx(SECRETS, fakeFetch(r));

describe('indexa adapter', () => {
  it('sends the token header and maps accounts in EUR (latest performance date wins)', async () => {
    const fetch = fakeFetch(routes());
    const result = await indexaAdapter.sync(makeCtx(SECRETS, fetch), makeConnection('indexa'));
    await expectSyncShape(result);
    expect(fetch.calls[0]?.headers['X-AUTH-TOKEN']).toBe('demo-indexa-token');
    expect(result.accounts.map((a) => [a.externalId, a.type, a.currency, a.balance])).toEqual([
      ['ABCD1234', 'brokerage', 'EUR', 1_050_075],
      ['PENS5678', 'retirement', 'EUR', 512_040],
    ]);
  });

  it('reads holdings from total fiscal results, with real lots from the per-purchase rows', async () => {
    const { holdings } = await indexaAdapter.sync(ctxFor(), makeConnection('indexa'));
    const stocks = holdings.find((h) => h.symbol === 'IE0000000011');
    expect(stocks).toMatchObject({
      quantity: '25',
      price: '20.5',
      costBasis: 46_800,
      securityType: 'mutual_fund',
    });
    expect(stocks?.lots).toEqual([
      {
        externalId: null,
        acquiredOn: '2025-02-03',
        quantity: '10',
        costBasis: 18_000,
        currency: 'EUR',
      },
      {
        externalId: null,
        acquiredOn: '2025-08-04',
        quantity: '15',
        costBasis: 28_800,
        currency: 'EUR',
      },
    ]);
    expect(holdings.find((h) => h.symbol === 'IE0000000022')?.lots).toHaveLength(1);
  });

  it('falls back to the portfolio snapshot for pension plans', async () => {
    const { holdings } = await indexaAdapter.sync(ctxFor(), makeConnection('indexa'));
    expect(holdings.find((h) => h.accountExternalId === 'PENS5678')).toMatchObject({
      symbol: 'ES0000000033',
      quantity: '400',
      costBasis: 480_000,
      lots: null,
    });
  });

  it('stores broker lots and an opening lot for the pension plan, quiet on repeat', async () => {
    const { store } = await expectRepeatSyncIsQuiet(indexaAdapter, () => ctxFor());
    const lotsOf = (isin: string) =>
      store.taxLots.filter(
        (l) =>
          l.holdingId ===
          store.holdings.find(
            (h) => h.securityId === store.securities.find((s) => s.symbol === isin)?.id,
          )?.id,
      );
    expect(lotsOf('IE0000000011').map((l) => l.source)).toEqual(['broker', 'broker']);
    expect(lotsOf('ES0000000033')).toHaveLength(1);
    expect(lotsOf('ES0000000033')[0]).toMatchObject({
      source: 'derived',
      quantity: '400',
      costBasis: 480_000,
    });
  });

  it('asks for repair when the token is rejected', async () => {
    await expectRepairOnExpiredToken(indexaAdapter, () =>
      ctxFor(routes({ [`GET ${H}/users/me`]: { status: 401, json: { detail: 'Unauthorized' } } })),
    );
  });
});
