import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { snaptradeAdapter, snaptradeSignature } from '../src/adapters/snaptrade';
import { fakeFetch, fixture, makeConnection, makeCtx, type FakeCall } from './helpers/fakeFetch';
import {
  expectRepairOnExpiredToken,
  expectRepeatSyncIsQuiet,
  expectSyncShape,
} from './helpers/contract';
import { MemoryStore } from './helpers/store';

const SECRETS = {
  SNAPTRADE_CLIENT_ID: 'DEMO-CLIENT',
  SNAPTRADE_CONSUMER_KEY: 'demo-consumer-key',
  SNAPTRADE_USER_ID: 'demo-user',
  SNAPTRADE_USER_SECRET: 'demo-user-secret',
  SNAPTRADE_AUTHORIZATION_ID: 'auth-demo-1',
};
const H = 'api.snaptrade.com/api/v1';

function routes(over: Record<string, unknown> = {}) {
  return {
    [`GET ${H}/authorizations`]: { json: fixture('snaptrade', 'authorizations.json') },
    [`GET ${H}/accounts`]: { json: fixture('snaptrade', 'accounts.json') },
    [`GET ${H}/accounts/st-acc-1/balances`]: { json: fixture('snaptrade', 'balances_1.json') },
    [`GET ${H}/accounts/st-acc-2/balances`]: { json: fixture('snaptrade', 'balances_2.json') },
    [`GET ${H}/accounts/st-acc-1/positions`]: { json: fixture('snaptrade', 'positions_1.json') },
    [`GET ${H}/accounts/st-acc-2/positions`]: { json: fixture('snaptrade', 'positions_2.json') },
    [`GET ${H}/accounts/st-acc-1/activities`]: (call: FakeCall) => ({
      json:
        call.url.searchParams.get('offset') === '0'
          ? fixture('snaptrade', 'activities_1_page1.json')
          : fixture('snaptrade', 'activities_1_page2.json'),
    }),
    [`GET ${H}/accounts/st-acc-2/activities`]: { json: fixture('snaptrade', 'activities_2.json') },
    ...over,
  };
}
const ctxFor = (r = routes()) => makeCtx(SECRETS, fakeFetch(r));

describe('snaptrade adapter', () => {
  it('signs requests: HMAC-SHA256 of sorted {content,path,query}', async () => {
    const sig = await snaptradeSignature(
      'k',
      '/api/v1/accounts',
      'clientId=C&timestamp=1',
      undefined,
    );
    const expected = createHmac('sha256', 'k')
      .update('{"content":null,"path":"/api/v1/accounts","query":"clientId=C&timestamp=1"}')
      .digest('base64');
    expect(sig).toBe(expected);
    const withBody = await snaptradeSignature('k', '/p', 'q=1', '{"b":2,"a":{"d":1,"c":2}}');
    expect(withBody).toBe(
      createHmac('sha256', 'k')
        .update('{"content":{"a":{"c":2,"d":1},"b":2},"path":"/p","query":"q=1"}')
        .digest('base64'),
    );
  });

  it('sends clientId, timestamp, user and a matching Signature on each call', async () => {
    const fetch = fakeFetch(routes());
    await snaptradeAdapter.sync(makeCtx(SECRETS, fetch), makeConnection('snaptrade'));
    const call = fetch.calls[0];
    expect(call?.url.searchParams.get('clientId')).toBe('DEMO-CLIENT');
    expect(call?.url.searchParams.get('userId')).toBe('demo-user');
    expect(call?.url.searchParams.get('userSecret')).toBe('demo-user-secret');
    const query = (call?.url.search ?? '').slice(1);
    const expected = createHmac('sha256', 'demo-consumer-key')
      .update(`{"content":null,"path":"/api/v1/authorizations","query":${JSON.stringify(query)}}`)
      .digest('base64');
    expect(call?.headers.Signature).toBe(expected);
  });

  it('keeps only accounts of this connection, with balances and positions', async () => {
    const result = await snaptradeAdapter.sync(ctxFor(), makeConnection('snaptrade'));
    await expectSyncShape(result);
    expect(result.accounts.map((a) => [a.externalId, a.type, a.subtype, a.balance])).toEqual([
      ['st-acc-1', 'brokerage', 'taxable', 1_784_065],
      ['st-acc-2', 'retirement', 'roth_ira', 520_000],
    ]);
    const aapl = result.holdings.find((h) => h.symbol === 'AAPL');
    expect(aapl).toMatchObject({
      quantity: '10.5',
      price: '200',
      costBasis: 157_500,
      exchange: 'NASDAQ',
      securityType: 'equity',
      lots: null,
    });
    expect(result.holdings.find((h) => h.symbol === 'VTI')).toMatchObject({
      securityType: 'etf',
      quantity: '50',
      exchange: 'ARCA',
    });
  });

  it('normalises activity cash by type and skips options', async () => {
    const { activities } = await snaptradeAdapter.sync(ctxFor(), makeConnection('snaptrade'));
    const byId = new Map(activities.map((a) => [a.externalId, a]));
    expect(byId.get('st-a-1')).toMatchObject({ type: 'buy', amount: -60_000, quantity: '5' });
    expect(byId.get('st-a-3')).toMatchObject({
      type: 'sell',
      amount: 19_500,
      quantity: '1',
      fees: 50,
    });
    expect(byId.get('st-a-4')).toMatchObject({ type: 'dividend', amount: 240, quantity: null });
    expect(byId.get('st-b-1')).toMatchObject({
      type: 'contribution',
      amount: 500_000,
      symbol: null,
    });
    expect(byId.has('st-a-5')).toBe(false);
  });

  it('pages activities by offset and asks for all history on the first sync', async () => {
    const fetch = fakeFetch(routes());
    await snaptradeAdapter.sync(makeCtx(SECRETS, fetch), makeConnection('snaptrade'));
    const pages = fetch.calls.filter((c) => c.url.pathname.endsWith('/st-acc-1/activities'));
    expect(pages.map((c) => c.url.searchParams.get('offset'))).toEqual(['0', '2']);
    expect(pages[0]?.url.searchParams.get('startDate')).toBe('2000-01-01');
    const next = fakeFetch(routes());
    await snaptradeAdapter.sync(
      makeCtx(SECRETS, next),
      makeConnection('snaptrade', { syncCursor: '{"since":"2026-11-01"}' }),
    );
    expect(
      next.calls
        .find((c) => c.url.pathname.endsWith('/st-acc-2/activities'))
        ?.url.searchParams.get('startDate'),
    ).toBe('2026-10-02');
  });

  it('derives lots with FIFO from activities and covers older history with an opening lot', async () => {
    const store = new MemoryStore();
    const conn = makeConnection('snaptrade');
    store.apply(conn, await snaptradeAdapter.sync(ctxFor(), conn));
    const aapl = store.securities.find((s) => s.symbol === 'AAPL');
    const holding = store.holdings.find((h) => h.securityId === aapl?.id);
    const lots = store.taxLots.filter((l) => l.holdingId === holding?.id);
    // Bought 5 @120 and 5.5 @180, sold 1 from the oldest: 4 + 5.5 = 9.5. Broker says 10.5, so 1 unit is opening balance.
    expect(lots.map((l) => [l.acquiredOn, l.quantity, l.source])).toEqual([
      ['2024-02-12', '4', 'derived'],
      ['2025-06-03', '5.5', 'derived'],
      ['2024-02-12', '1', 'derived'],
    ]);
    expect(lots.reduce((n, l) => n + l.costBasis, 0)).toBe(157_500); // broker cost: 10.5 x 150
    // VTI has no activity, so its single lot is the opening balance.
    const vti = store.securities.find((s) => s.symbol === 'VTI');
    expect(
      store.taxLots.filter(
        (l) => l.holdingId === store.holdings.find((h) => h.securityId === vti?.id)?.id,
      ),
    ).toHaveLength(1);
  });

  it('repeat syncs add nothing', async () => {
    await expectRepeatSyncIsQuiet(snaptradeAdapter, () => ctxFor());
  });

  it('asks for repair when the authorization is disabled, missing, or the call is rejected', async () => {
    await expectRepairOnExpiredToken(snaptradeAdapter, () =>
      ctxFor(
        routes({
          [`GET ${H}/authorizations`]: {
            json: fixture('snaptrade', 'authorizations_disabled.json'),
          },
        }),
      ),
    );
    await expectRepairOnExpiredToken(snaptradeAdapter, () =>
      ctxFor(
        routes({
          [`GET ${H}/authorizations`]: { status: 401, json: { detail: 'Unable to verify user' } },
        }),
      ),
    );
    const missing = makeCtx(
      { ...SECRETS, SNAPTRADE_AUTHORIZATION_ID: 'gone' },
      fakeFetch(routes()),
    );
    await expect(snaptradeAdapter.sync(missing, makeConnection('snaptrade'))).rejects.toThrow(
      /no longer exists/,
    );
  });
});
