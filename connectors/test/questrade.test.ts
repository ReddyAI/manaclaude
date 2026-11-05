import { describe, expect, it } from 'vitest';
import { mapQuestradeAccount, questradeAdapter } from '../src/adapters/questrade';
import { fakeFetch, fixture, makeConnection, makeCtx, type FakeCall } from './helpers/fakeFetch';
import {
  expectRepairOnExpiredToken,
  expectRepeatSyncIsQuiet,
  expectSyncShape,
} from './helpers/contract';

const SECRETS = { QUESTRADE_REFRESH_TOKEN: 'demo-refresh-token-1' };
const L = 'login.questrade.com/oauth2/token';
const A = 'api01.iq.questrade.com/v1';

/** Activities that fall inside the asked window, like the real API. */
const inWindow = (rows: { tradeDate?: string }[], call: FakeCall) => {
  const from = (call.url.searchParams.get('startTime') ?? '').slice(0, 10);
  const to = (call.url.searchParams.get('endTime') ?? '').slice(0, 10);
  return rows.filter(
    (r) => (r.tradeDate ?? '').slice(0, 10) >= from && (r.tradeDate ?? '').slice(0, 10) <= to,
  );
};

function routes(over: Record<string, unknown> = {}) {
  const tfsa = fixture<{ activities: { tradeDate?: string }[] }>(
    'questrade',
    'activities_tfsa.json',
  );
  return {
    [`POST ${L}`]: { json: fixture('questrade', 'token.json') },
    [`GET ${A}/accounts`]: { json: fixture('questrade', 'accounts.json') },
    [`GET ${A}/accounts/51000001/balances`]: { json: fixture('questrade', 'balances_tfsa.json') },
    [`GET ${A}/accounts/51000002/balances`]: { json: fixture('questrade', 'balances_rrsp.json') },
    [`GET ${A}/accounts/51000001/positions`]: { json: fixture('questrade', 'positions_tfsa.json') },
    [`GET ${A}/accounts/51000002/positions`]: { json: fixture('questrade', 'positions_rrsp.json') },
    [`GET ${A}/accounts/51000001/activities`]: (call: FakeCall) => ({
      json: { activities: inWindow(tfsa.activities, call) },
    }),
    [`GET ${A}/accounts/51000002/activities`]: {
      json: fixture('questrade', 'activities_rrsp.json'),
    },
    ...over,
  };
}
const ctxFor = (r = routes()) => makeCtx(SECRETS, fakeFetch(r));

describe('questrade adapter', () => {
  it('exchanges the refresh token and hands back the new one to store', async () => {
    const fetch = fakeFetch(routes());
    const result = await questradeAdapter.sync(
      makeCtx(SECRETS, fetch),
      makeConnection('questrade'),
    );
    expect(fetch.calls[0]?.url.searchParams.get('grant_type')).toBe('refresh_token');
    expect(fetch.calls[0]?.url.searchParams.get('refresh_token')).toBe('demo-refresh-token-1');
    expect(result.updatedSecrets).toEqual({ QUESTRADE_REFRESH_TOKEN: 'demo-refresh-token-2' });
    expect(fetch.calls[1]?.headers.Authorization).toBe('Bearer demo-access-token-1');
  });

  it('maps accounts: TFSA and RRSP types, CAD combined balance, closed accounts skipped', async () => {
    const result = await questradeAdapter.sync(ctxFor(), makeConnection('questrade'));
    await expectSyncShape(result);
    expect(
      result.accounts.map((a) => [a.externalId, a.type, a.subtype, a.currency, a.balance]),
    ).toEqual([
      ['51000001', 'brokerage', 'tfsa', 'CAD', 561_000],
      ['51000002', 'retirement', 'rrsp', 'CAD', 1_000],
    ]);
    expect(mapQuestradeAccount('Margin')).toEqual({ type: 'brokerage', subtype: 'taxable' });
    expect(mapQuestradeAccount('LIRA').type).toBe('retirement');
  });

  it('keeps per-position currency (.TO is CAD) and the broker cost', async () => {
    const { holdings } = await questradeAdapter.sync(ctxFor(), makeConnection('questrade'));
    expect(holdings.find((h) => h.symbol === 'XIU')).toMatchObject({
      currency: 'CAD',
      exchange: 'TSX',
      quantity: '100',
      costBasis: 350_000,
    });
    expect(holdings.find((h) => h.symbol === 'AAPL')).toMatchObject({
      currency: 'USD',
      costBasis: 75_000,
    });
  });

  it('reads activities in 31-day windows and signs them from netAmount', async () => {
    const fetch = fakeFetch(routes());
    const { activities } = await questradeAdapter.sync(
      makeCtx(SECRETS, fetch),
      makeConnection('questrade'),
    );
    const windows = fetch.calls.filter((c) => c.url.pathname.endsWith('/51000001/activities'));
    expect(windows.length).toBeGreaterThanOrEqual(11);
    for (const w of windows) {
      const days =
        (Date.parse((w.url.searchParams.get('endTime') ?? '').slice(0, 10)) -
          Date.parse((w.url.searchParams.get('startTime') ?? '').slice(0, 10))) /
        86_400_000;
      expect(days).toBeLessThanOrEqual(31);
    }
    const buys = activities.filter((a) => a.type === 'buy');
    expect(buys.map((a) => a.amount)).toEqual([-204_495, -146_495, -146_495]);
    expect(new Set(buys.map((a) => a.externalId)).size).toBe(3); // two identical buys keep separate ids
    expect(activities.find((a) => a.type === 'sell')).toMatchObject({
      amount: 151_505,
      quantity: '40',
    });
    expect(activities.find((a) => a.type === 'contribution')).toMatchObject({ amount: 50_000 });
    expect(activities.find((a) => a.type === 'dividend')).toMatchObject({
      amount: 2_000,
      symbol: 'XIU',
    });
  });

  it('derives lots (FIFO) and covers earlier history with an opening lot', async () => {
    const { store } = await expectRepeatSyncIsQuiet(questradeAdapter, () => ctxFor());
    const xiu = store.securities.find((s) => s.symbol === 'XIU');
    const lots = store.taxLots.filter(
      (l) => l.holdingId === store.holdings.find((h) => h.securityId === xiu?.id)?.id,
    );
    // Bought 60, 40, 40; sold 40 from the oldest -> 20 + 40 + 40 = 100.
    expect(lots.map((l) => [l.acquiredOn, l.quantity])).toEqual([
      ['2026-02-10', '20'],
      ['2026-03-10', '40'],
      ['2026-03-10', '40'],
    ]);
  });

  it('asks for repair when the refresh token is rejected', async () => {
    await expectRepairOnExpiredToken(questradeAdapter, () =>
      ctxFor(
        routes({
          [`POST ${L}`]: { status: 400, json: fixture('questrade', 'token_invalid.json') },
        }),
      ),
    );
    await expectRepairOnExpiredToken(questradeAdapter, () =>
      ctxFor(routes({ [`GET ${A}/accounts`]: { status: 401, json: {} } })),
    );
  });
});
