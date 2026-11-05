import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { coinspotAdapter } from '../src/adapters/coinspot';
import { fakeFetch, fixture, makeConnection, makeCtx } from './helpers/fakeFetch';
import {
  expectRepairOnExpiredToken,
  expectRepeatSyncIsQuiet,
  expectSyncShape,
} from './helpers/contract';

const SECRETS = { COINSPOT_API_KEY: 'demo-cs-key', COINSPOT_API_SECRET: 'demo-cs-secret' };
const H = 'www.coinspot.com.au/api/v2/ro';

const routes = (over: Record<string, unknown> = {}) => ({
  [`POST ${H}/my/balances`]: { json: fixture('coinspot', 'balances.json') },
  [`POST ${H}/my/orders/completed`]: { json: fixture('coinspot', 'orders.json') },
  ...over,
});
const ctxFor = (r = routes()) => makeCtx(SECRETS, fakeFetch(r));

describe('coinspot adapter', () => {
  it('signs the exact JSON body with HMAC-SHA512 and sends the key header', async () => {
    const fetch = fakeFetch(routes());
    await coinspotAdapter.sync(makeCtx(SECRETS, fetch), makeConnection('coinspot'));
    const call = fetch.calls[0];
    expect(call?.headers.key).toBe('demo-cs-key');
    expect(call?.headers.sign).toBe(
      createHmac('sha512', 'demo-cs-secret')
        .update(call?.body ?? '')
        .digest('hex'),
    );
    expect(JSON.parse(call?.body ?? '{}').nonce).toBeGreaterThan(0);
  });

  it('builds an AUD crypto account from balances and the AUD rate', async () => {
    const result = await coinspotAdapter.sync(ctxFor(), makeConnection('coinspot'));
    await expectSyncShape(result);
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0]).toMatchObject({
      symbol: 'BTC',
      quantity: '0.05',
      price: '90000',
      currency: 'AUD',
    });
    expect(result.accounts[0]).toMatchObject({
      type: 'crypto',
      currency: 'AUD',
      balance: 50_025 + 450_000,
    });
  });

  it('signs orders: buys out including fees, sells in net of fees; id-less identical orders stay separate', async () => {
    const { activities } = await coinspotAdapter.sync(ctxFor(), makeConnection('coinspot'));
    const buys = activities.filter((a) => a.type === 'buy');
    expect(buys).toHaveLength(3);
    expect(new Set(buys.map((a) => a.externalId)).size).toBe(3);
    expect(buys.filter((a) => a.amount === -160_880)).toHaveLength(2); // 1600 + 8 + 0.80
    expect(activities.find((a) => a.externalId === 'cs_cs-order-13')).toMatchObject({
      type: 'sell',
      amount: 91_494,
      fees: 506,
    });
  });

  it('derives lots and is quiet on a repeat sync, keeping both identical buys', async () => {
    const { store } = await expectRepeatSyncIsQuiet(coinspotAdapter, () => ctxFor());
    expect(store.activities.filter((a) => a.type === 'buy' && a.amount === -160_880)).toHaveLength(
      2,
    );
    const btc = store.securities.find((s) => s.symbol === 'BTC');
    const lots = store.taxLots.filter(
      (l) => l.holdingId === store.holdings.find((h) => h.securityId === btc?.id)?.id,
    );
    expect(lots.reduce((n, l) => n + Number(l.quantity), 0)).toBeCloseTo(0.05, 8);
  });

  it('asks for repair on 401 and on an error status mentioning the key', async () => {
    await expectRepairOnExpiredToken(coinspotAdapter, () =>
      ctxFor(routes({ [`POST ${H}/my/balances`]: { status: 401, json: {} } })),
    );
    await expectRepairOnExpiredToken(coinspotAdapter, () =>
      ctxFor(
        routes({ [`POST ${H}/my/balances`]: { json: fixture('coinspot', 'error_auth.json') } }),
      ),
    );
  });
});
