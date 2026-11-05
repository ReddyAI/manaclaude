import { describe, expect, it } from 'vitest';
import {
  createPlaidUpdateLinkToken,
  mapPlaidAccountType,
  plaidAdapter,
} from '../src/adapters/plaid';
import { fakeFetch, fixture, makeConnection, makeCtx, type FakeCall } from './helpers/fakeFetch';
import {
  expectRepairOnExpiredToken,
  expectRepeatSyncIsQuiet,
  expectSyncShape,
} from './helpers/contract';
import { MemoryStore } from './helpers/store';

const SECRETS = {
  PLAID_CLIENT_ID: 'demo-client',
  PLAID_SECRET: 'demo-secret',
  PLAID_ENV: 'sandbox',
  PLAID_ACCESS_TOKEN: 'access-sandbox-demo',
};
const H = 'sandbox.plaid.com';

function routes(stage: 'first' | 'posted' = 'first', extra: Record<string, unknown> = {}) {
  return {
    [`POST ${H}/accounts/get`]: { json: fixture('plaid', 'accounts_get.json') },
    [`POST ${H}/transactions/sync`]: (call: FakeCall) => {
      const cursor = JSON.parse(call.body ?? '{}').cursor;
      if (stage === 'posted') return { json: fixture('plaid', 'sync_posted.json') };
      return {
        json:
          cursor === 'cursor-page-1'
            ? fixture('plaid', 'sync_page2.json')
            : fixture('plaid', 'sync_page1.json'),
      };
    },
    [`POST ${H}/investments/holdings/get`]: { json: fixture('plaid', 'holdings_get.json') },
    [`POST ${H}/investments/transactions/get`]: {
      json: fixture('plaid', 'investments_transactions.json'),
    },
    [`POST ${H}/liabilities/get`]: { json: fixture('plaid', 'liabilities_get.json') },
    ...extra,
  };
}
const ctxFor = (r = routes()) => makeCtx(SECRETS, fakeFetch(r));

describe('plaid adapter', () => {
  it('maps accounts with the model sign rule and the limit', async () => {
    const result = await plaidAdapter.sync(ctxFor(), makeConnection('plaid'));
    await expectSyncShape(result);
    const byId = new Map(result.accounts.map((a) => [a.externalId, a]));
    expect(byId.get('pl_acc_chk')).toMatchObject({
      type: 'checking',
      balance: 842_017,
      availableBalance: 832_017,
    });
    expect(byId.get('pl_acc_card')).toMatchObject({
      type: 'credit_card',
      balance: 128_433,
      creditLimit: 1_200_000,
      interestRate: '24.99',
    });
    expect(byId.get('pl_acc_brk')).toMatchObject({
      type: 'brokerage',
      subtype: 'taxable',
      balance: 1_531_040,
    });
    expect(byId.get('pl_acc_401k')).toMatchObject({ type: 'retirement', subtype: '401k' });
  });

  it('flips Plaid signs: positive amount is money out', async () => {
    const { transactions } = await plaidAdapter.sync(ctxFor(), makeConnection('plaid'));
    const byId = new Map(transactions.map((t) => [t.externalId, t]));
    expect(byId.get('pl_t_pending1')?.amount).toBe(-450);
    expect(byId.get('pl_t_pay')?.amount).toBe(285_000);
    expect(byId.get('pl_t_card1')?.amount).toBe(-8_642);
    expect(byId.get('pl_t_cardpay')?.amount).toBe(50_000);
    expect(byId.get('pl_t_eur')).toMatchObject({ amount: -4_250, currency: 'EUR' });
    expect(byId.get('pl_t_pay')?.categoryHint).toBe('INCOME_WAGES');
  });

  it('follows has_more and saves the last cursor', async () => {
    const fetch = fakeFetch(routes());
    const result = await plaidAdapter.sync(makeCtx(SECRETS, fetch), makeConnection('plaid'));
    const syncCalls = fetch.calls.filter((c) => c.url.pathname === '/transactions/sync');
    expect(syncCalls.map((c) => JSON.parse(c.body ?? '{}').cursor)).toEqual([
      undefined,
      'cursor-page-1',
    ]);
    expect(JSON.parse(result.nextCursor ?? '{}').cursor).toBe('cursor-page-2');
    expect(result.deltaOnly).toBe(true);

    const again = fakeFetch(routes('posted'));
    await plaidAdapter.sync(
      makeCtx(SECRETS, again),
      makeConnection('plaid', { syncCursor: result.nextCursor }),
    );
    const resumed = again.calls.find((c) => c.url.pathname === '/transactions/sync');
    expect(JSON.parse(resumed?.body ?? '{}').cursor).toBe('cursor-page-2');
  });

  it('restarts from the saved cursor when data changes during paging', async () => {
    let n = 0;
    const r = routes('first', {
      [`POST ${H}/transactions/sync`]: (call: FakeCall) => {
        const cursor = JSON.parse(call.body ?? '{}').cursor;
        n++;
        if (n === 2) return { status: 400, json: fixture('plaid', 'error_mutation.json') };
        return {
          json:
            cursor === 'cursor-page-1'
              ? fixture('plaid', 'sync_page2.json')
              : fixture('plaid', 'sync_page1.json'),
        };
      },
    });
    const result = await plaidAdapter.sync(ctxFor(r), makeConnection('plaid'));
    expect(result.transactions.map((t) => t.externalId)).toContain('pl_t_coffee_b');
  });

  it('links pending to posted through pending_transaction_id and keeps the row', async () => {
    const store = new MemoryStore();
    const conn = makeConnection('plaid');
    const first = await plaidAdapter.sync(ctxFor(), conn);
    store.apply(conn, first);
    const pendingRow = store.transactions.find((t) => t.externalId === 'pl_t_pending1');
    expect(pendingRow?.pending).toBe(true);
    const count = store.transactions.length;

    const second = await plaidAdapter.sync(ctxFor(routes('posted')), {
      ...conn,
      syncCursor: first.nextCursor,
    });
    expect(second.removedTransactionExternalIds).toEqual(['pl_t_pending1']);
    const { txn } = store.apply(conn, second);
    const row = store.transactions.find((t) => t.id === pendingRow?.id);
    expect(row).toMatchObject({
      externalId: 'pl_t_posted1',
      pending: false,
      pendingExternalId: 'pl_t_pending1',
      date: '2026-11-04',
    });
    expect(txn.removals).toEqual([]);
    expect(store.transactions.length).toBe(count);
    // The modified card purchase picked up its new amount.
    expect(store.transactions.find((t) => t.externalId === 'pl_t_card1')?.amount).toBe(-8_810);
  });

  it('keeps two identical coffees and is quiet on a repeat sync', async () => {
    const { store } = await expectRepeatSyncIsQuiet(plaidAdapter, () => ctxFor());
    expect(
      store.transactions.filter((t) => t.date === '2026-10-30' && t.amount === -450),
    ).toHaveLength(2);
  });

  it('does not expire a long-pending row on a delta-only result', async () => {
    const store = new MemoryStore();
    const conn = makeConnection('plaid');
    const first = await plaidAdapter.sync(ctxFor(), conn);
    store.apply(conn, first, '2026-11-05T12:00:00.000Z');
    const quiet = { ...first, transactions: [], removedTransactionExternalIds: [] };
    const { txn } = store.apply(conn, quiet, '2026-12-30T12:00:00.000Z');
    expect(txn.removals).toEqual([]);
  });

  it('uses broker tax lots when Plaid sends them and derives the rest from activity', async () => {
    const store = new MemoryStore();
    const conn = makeConnection('plaid');
    const result = await plaidAdapter.sync(ctxFor(), conn);
    expect(result.holdings.map((h) => h.symbol)).toEqual(['VTI', 'MSFT', 'IDXFX']); // brokerage cash is not a holding
    const vti = result.holdings.find((h) => h.symbol === 'VTI');
    expect(vti?.lots).toHaveLength(2);
    expect(vti).toMatchObject({ exchange: 'ARCA', costBasis: 705_000 });
    store.apply(conn, result);

    const sec = (sym: string) => store.securities.find((s) => s.symbol === sym);
    const holding = (sym: string) => store.holdings.find((h) => h.securityId === sec(sym)?.id);
    const lotsOf = (sym: string) => store.taxLots.filter((l) => l.holdingId === holding(sym)?.id);

    expect(lotsOf('VTI').map((l) => [l.source, l.acquiredOn, l.quantity, l.costBasis])).toEqual([
      ['broker', '2025-01-15', '10', 220_000],
      ['broker', '2025-09-02', '20', 485_000],
    ]);
    // MSFT: bought 10 and 5, sold 3 from the oldest lot -> 7 + 5 = 12, FIFO cost.
    const msft = lotsOf('MSFT');
    expect(msft.every((l) => l.source === 'derived')).toBe(true);
    expect(msft.map((l) => [l.acquiredOn, l.quantity, l.costBasis])).toEqual([
      ['2025-03-10', '7', 252_000],
      ['2025-07-21', '5', 190_000],
    ]);
    // The 401k has no activity, so one opening lot carries the broker's cost basis.
    const fund = lotsOf('IDXFX');
    expect(fund).toHaveLength(1);
    expect(fund[0]).toMatchObject({ quantity: '250.5', costBasis: 3_100_000, source: 'derived' });
    expect(sec('MSFT')?.exchange).toBe('NASDAQ');
    // Dividend and deposit activity were kept.
    expect(store.activities.map((a) => a.type).sort()).toEqual([
      'buy',
      'buy',
      'contribution',
      'dividend',
      'sell',
    ]);
    expect(store.activities.find((a) => a.type === 'buy')?.amount).toBeLessThan(0);
    expect(store.activities.find((a) => a.type === 'sell')?.amount).toBeGreaterThan(0);
  });

  it('skips investments when the login does not support them', async () => {
    const r = routes('first', {
      [`POST ${H}/investments/holdings/get`]: {
        status: 400,
        json: fixture('plaid', 'error_not_supported.json'),
      },
    });
    const result = await plaidAdapter.sync(ctxFor(r), makeConnection('plaid'));
    expect(result.holdings).toEqual([]);
    expect(result.accounts).toHaveLength(4);
  });

  it('asks for repair on ITEM_LOGIN_REQUIRED and on 401', async () => {
    await expectRepairOnExpiredToken(plaidAdapter, () =>
      makeCtx(
        SECRETS,
        fakeFetch({
          [`POST ${H}/accounts/get`]: {
            status: 400,
            json: fixture('plaid', 'error_login_required.json'),
          },
        }),
      ),
    );
    await expectRepairOnExpiredToken(plaidAdapter, () =>
      makeCtx(SECRETS, fakeFetch({ [`POST ${H}/accounts/get`]: { status: 401, json: {} } })),
    );
  });

  it('sends the app keys as headers and the access token in the body', async () => {
    const fetch = fakeFetch(routes());
    await plaidAdapter.sync(makeCtx(SECRETS, fetch), makeConnection('plaid'));
    const first = fetch.calls[0];
    expect(first?.headers['PLAID-CLIENT-ID']).toBe('demo-client');
    expect(JSON.parse(first?.body ?? '{}').access_token).toBe('access-sandbox-demo');
  });

  it('builds an update-mode link token for repair', async () => {
    const fetch = fakeFetch({
      [`POST ${H}/link/token/create`]: { json: { link_token: 'link-sandbox-demo' } },
    });
    const token = await createPlaidUpdateLinkToken(makeCtx(SECRETS, fetch), { userId: 'me' });
    expect(token).toBe('link-sandbox-demo');
    expect(JSON.parse(fetch.calls[0]?.body ?? '{}').access_token).toBe('access-sandbox-demo');
  });

  it('maps Plaid account types', () => {
    expect(mapPlaidAccountType('depository', 'money market')).toEqual({
      type: 'savings',
      subtype: 'money_market',
    });
    expect(mapPlaidAccountType('loan', 'mortgage').type).toBe('mortgage');
    expect(mapPlaidAccountType('investment', 'roth')).toEqual({
      type: 'retirement',
      subtype: 'roth_ira',
    });
    expect(mapPlaidAccountType('other', null).type).toBe('other_asset');
  });
});
