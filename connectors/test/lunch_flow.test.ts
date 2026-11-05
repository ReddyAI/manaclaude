import { describe, expect, it } from 'vitest';
import { isUnidentifiedHold, lunchFlowAdapter } from '../src/adapters/lunch_flow';
import { fakeFetch, fixture, makeConnection, makeCtx } from './helpers/fakeFetch';
import {
  expectRepairOnExpiredToken,
  expectRepeatSyncIsQuiet,
  expectSyncShape,
} from './helpers/contract';
import { MemoryStore } from './helpers/store';

const SECRETS = { LUNCHFLOW_API_KEY: 'demo-lf-key' };
const H = 'lunchflow.app/api/v1';

function routes(txPosted = false) {
  return {
    [`GET ${H}/accounts`]: { json: fixture('lunch_flow', 'accounts.json') },
    [`GET ${H}/accounts/4101/balance`]: { json: fixture('lunch_flow', 'balance_4101.json') },
    [`GET ${H}/accounts/4102/balance`]: { json: fixture('lunch_flow', 'balance_4102.json') },
    [`GET ${H}/accounts/4103/balance`]: { json: fixture('lunch_flow', 'balance_4103.json') },
    [`GET ${H}/accounts/4101/holdings`]: { status: 501, json: {} },
    [`GET ${H}/accounts/4102/holdings`]: { status: 501, json: {} },
    [`GET ${H}/accounts/4103/holdings`]: { json: fixture('lunch_flow', 'holdings_4103.json') },
    [`GET ${H}/accounts/4101/transactions`]: {
      json: fixture(
        'lunch_flow',
        txPosted ? 'transactions_posted_4101.json' : 'transactions_4101.json',
      ),
    },
    [`GET ${H}/accounts/4102/transactions`]: {
      json: fixture('lunch_flow', 'transactions_4102.json'),
    },
    [`GET ${H}/accounts/4103/transactions`]: {
      json: fixture('lunch_flow', 'transactions_empty.json'),
    },
  };
}
const ctxFor = (posted = false) => makeCtx(SECRETS, fakeFetch(routes(posted)));

describe('lunch flow adapter', () => {
  it('sends the API key and skips accounts that are not active', async () => {
    const fetch = fakeFetch(routes());
    const result = await lunchFlowAdapter.sync(
      makeCtx(SECRETS, fetch),
      makeConnection('lunch_flow'),
    );
    await expectSyncShape(result);
    expect(fetch.calls[0]?.headers['x-api-key']).toBe('demo-lf-key');
    expect(result.accounts.map((a) => a.externalId)).toEqual(['4101', '4102', '4103']);
  });

  it('negates card balances (provider: negative when owed) and keeps assets as they are', async () => {
    const { accounts } = await lunchFlowAdapter.sync(ctxFor(), makeConnection('lunch_flow'));
    const byId = new Map(accounts.map((a) => [a.externalId, a]));
    expect(byId.get('4101')).toMatchObject({ type: 'checking', balance: 312_055 });
    expect(byId.get('4102')).toMatchObject({ type: 'credit_card', balance: 128_433 });
    expect(byId.get('4103')).toMatchObject({ type: 'brokerage', balance: 520_000 });
  });

  it('reads holdings where supported and treats 501 as none', async () => {
    const { holdings } = await lunchFlowAdapter.sync(ctxFor(), makeConnection('lunch_flow'));
    expect(holdings).toHaveLength(1);
    expect(holdings[0]).toMatchObject({
      symbol: 'VTI',
      quantity: '18',
      costBasis: 420_000,
      accountExternalId: '4103',
    });
  });

  it('keeps signs, gives id-less rows a content id, and treats masked-card holds as money out', async () => {
    const { transactions } = await lunchFlowAdapter.sync(ctxFor(), makeConnection('lunch_flow'));
    const chk = transactions.filter((t) => t.accountExternalId === '4101');
    expect(chk.find((t) => t.externalId === 'lf-t-1')?.amount).toBe(-4_217);
    expect(chk.find((t) => t.externalId === 'lf-t-2')?.amount).toBe(180_000);
    const idless = chk.filter((t) => t.externalId.startsWith('pending_'));
    expect(idless).toHaveLength(2);
    expect(new Set(idless.map((t) => t.externalId)).size).toBe(2);
    expect(idless.every((t) => t.pending)).toBe(true);
    const hold = idless.find((t) => t.rawName === 'Card hold');
    expect(hold).toMatchObject({ amount: -2_500, merchantName: null });
    expect(
      isUnidentifiedHold({
        amount: 1,
        date: '2026-01-01',
        merchant: '****1234',
        description: 'CARD 5678',
      }),
    ).toBe(true);
    expect(
      isUnidentifiedHold({ id: 'x', amount: 1, date: '2026-01-01', merchant: '****1234' }),
    ).toBe(false);
    const card = transactions.filter((t) => t.accountExternalId === '4102');
    expect(card.find((t) => t.externalId === 'lf-c-1')?.amount).toBe(-8_642);
    expect(card.find((t) => t.externalId === 'lf-c-2')?.amount).toBe(50_000);
  });

  it('matches a posted row to the id-less pending hold', async () => {
    const store = new MemoryStore();
    const conn = makeConnection('lunch_flow');
    store.apply(conn, await lunchFlowAdapter.sync(ctxFor(), conn));
    const pending = store.transactions.filter((t) => t.pending && t.amount === -999);
    expect(pending).toHaveLength(1);
    const { txn } = store.apply(
      conn,
      await lunchFlowAdapter.sync(ctxFor(true), conn),
      '2026-11-06T12:00:00.000Z',
    );
    expect(txn.stats.postedFromPending).toBe(1);
    expect(store.transactions.find((t) => t.id === pending[0]?.id)).toMatchObject({
      externalId: 'lf-t-9',
      pending: false,
    });
  });

  it('keeps two identical coffees and is quiet on a repeat sync', async () => {
    const { store } = await expectRepeatSyncIsQuiet(lunchFlowAdapter, () => ctxFor());
    expect(
      store.transactions.filter((t) => t.date === '2026-10-30' && t.amount === -450),
    ).toHaveLength(2);
  });

  it('asks for repair when the key is rejected', async () => {
    await expectRepairOnExpiredToken(lunchFlowAdapter, () =>
      makeCtx(
        SECRETS,
        fakeFetch({
          [`GET ${H}/accounts`]: {
            status: 401,
            json: fixture('lunch_flow', 'error_unauthorized.json'),
          },
        }),
      ),
    );
  });
});
