import { describe, expect, it } from 'vitest';
import { tellerAdapter } from '../src/adapters/teller';
import { fakeFetch, fixture, makeConnection, makeCtx } from './helpers/fakeFetch';
import {
  expectRepairOnExpiredToken,
  expectRepeatSyncIsQuiet,
  expectSyncShape,
} from './helpers/contract';
import { MemoryStore } from './helpers/store';

const SECRETS = { TELLER_ACCESS_TOKEN: 'test_token_demo' };

function routes(chkPages: 'paged' | 'posted' = 'paged') {
  const pages: Record<string, unknown> = {
    '': fixture('teller', 'transactions_chk_page1.json'),
    txn_demo_c2: fixture('teller', 'transactions_chk_page2.json'),
    txn_demo_c4: fixture('teller', 'transactions_chk_page3.json'),
    txn_demo_c5: [],
  };
  return {
    'GET api.teller.io/accounts': { json: fixture('teller', 'accounts.json') },
    'GET api.teller.io/accounts/acc_demo_chk_01/balances': {
      json: fixture('teller', 'balances_chk.json'),
    },
    'GET api.teller.io/accounts/acc_demo_cc_01/balances': {
      json: fixture('teller', 'balances_cc.json'),
    },
    'GET api.teller.io/accounts/acc_demo_chk_01/transactions': (call: { url: URL }) => ({
      json:
        chkPages === 'posted'
          ? call.url.searchParams.get('from_id')
            ? []
            : fixture('teller', 'transactions_chk_posted.json')
          : (pages[call.url.searchParams.get('from_id') ?? ''] ?? []),
    }),
    'GET api.teller.io/accounts/acc_demo_cc_01/transactions': (call: { url: URL }) => ({
      json: call.url.searchParams.get('from_id') ? [] : fixture('teller', 'transactions_cc.json'),
    }),
  };
}

const ctxFor = (r = routes()) => makeCtx(SECRETS, fakeFetch(r));

describe('teller adapter', () => {
  it('maps accounts, skips closed ones and follows the card sign rule', async () => {
    const result = await tellerAdapter.sync(ctxFor(), makeConnection('teller'));
    await expectSyncShape(result);
    expect(result.accounts.map((a) => a.externalId)).toEqual(['acc_demo_chk_01', 'acc_demo_cc_01']);
    const card = result.accounts.find((a) => a.externalId === 'acc_demo_cc_01');
    expect(card).toMatchObject({
      type: 'credit_card',
      balance: 128_433,
      creditLimit: 1_200_000,
      mask: '1180',
    });
    const checking = result.accounts.find((a) => a.externalId === 'acc_demo_chk_01');
    expect(checking).toMatchObject({
      type: 'checking',
      balance: 842_017,
      availableBalance: 832_017,
    });
  });

  it('keeps money out negative and money in positive on banks and cards', async () => {
    const { transactions } = await tellerAdapter.sync(ctxFor(), makeConnection('teller'));
    const byId = new Map(transactions.map((t) => [t.externalId, t]));
    expect(byId.get('txn_demo_c2')?.amount).toBe(285_000); // payroll in
    expect(byId.get('txn_demo_c3')?.amount).toBe(-450); // coffee out
    expect(byId.get('txn_demo_k1')?.amount).toBe(-8_642); // card purchase is negative on the card
    expect(byId.get('txn_demo_k2')?.amount).toBe(50_000); // card payment is positive on the card
    expect(byId.get('txn_demo_c3')?.merchantName).toBe('Corner Coffee');
  });

  it('follows from_id pages until an empty page', async () => {
    const fetch = fakeFetch(routes());
    const result = await tellerAdapter.sync(makeCtx(SECRETS, fetch), makeConnection('teller'));
    const chk = result.transactions.filter((t) => t.accountExternalId === 'acc_demo_chk_01');
    expect(chk.map((t) => t.externalId)).toEqual([
      'txn_demo_c1',
      'txn_demo_c2',
      'txn_demo_c3',
      'txn_demo_c4',
      'txn_demo_c5',
    ]);
    const paged = fetch.calls.filter((c) =>
      c.url.pathname.endsWith('/acc_demo_chk_01/transactions'),
    );
    expect(paged.map((c) => c.url.searchParams.get('from_id'))).toEqual([
      null,
      'txn_demo_c2',
      'txn_demo_c4',
      'txn_demo_c5',
    ]);
  });

  it('sends the access token as basic auth with an empty password', async () => {
    const fetch = fakeFetch(routes());
    await tellerAdapter.sync(makeCtx(SECRETS, fetch), makeConnection('teller'));
    const auth = fetch.calls[0]?.headers.Authorization ?? '';
    expect(atob(auth.replace('Basic ', ''))).toBe('test_token_demo:');
  });

  it('turns a pending hold into the posted row without adding a duplicate', async () => {
    const store = new MemoryStore();
    const conn = makeConnection('teller');
    const first = await tellerAdapter.sync(ctxFor(), conn);
    store.apply(conn, first);
    const pending = store.transactions.find((t) => t.externalId === 'txn_demo_c1');
    expect(pending?.pending).toBe(true);
    const before = store.transactions.length;

    const second = await tellerAdapter.sync(ctxFor(routes('posted')), {
      ...conn,
      syncCursor: first.nextCursor,
    });
    const { txn } = store.apply(conn, second, '2026-11-06T12:00:00.000Z');
    const row = store.transactions.find((t) => t.id === pending?.id);
    expect(row).toMatchObject({
      externalId: 'txn_demo_c6',
      pending: false,
      pendingExternalId: 'txn_demo_c1',
      date: '2026-11-04',
    });
    expect(txn.stats.postedFromPending).toBe(1);
    expect(store.transactions.length).toBe(before);
  });

  it('keeps two identical coffees and adds nothing on a repeat sync', async () => {
    const { store } = await expectRepeatSyncIsQuiet(tellerAdapter, () => ctxFor());
    const coffees = store.transactions.filter((t) => t.date === '2026-10-30' && t.amount === -450);
    expect(coffees).toHaveLength(2);
    expect(new Set(coffees.map((t) => t.externalId)).size).toBe(2);
  });

  it('asks for repair on 401 and on a disconnected enrollment', async () => {
    await expectRepairOnExpiredToken(tellerAdapter, () =>
      makeCtx(
        SECRETS,
        fakeFetch({
          'GET api.teller.io/accounts': { status: 401, json: { error: { code: 'unauthorized' } } },
        }),
      ),
    );
    await expectRepairOnExpiredToken(tellerAdapter, () =>
      makeCtx(
        SECRETS,
        fakeFetch({
          'GET api.teller.io/accounts': {
            status: 404,
            json: fixture('teller', 'error_disconnected.json'),
          },
        }),
      ),
    );
  });

  it('asks for repair when the login credential is missing', async () => {
    await expectRepairOnExpiredToken(tellerAdapter, () => makeCtx({}, fakeFetch({})));
  });

  it('reports health from a cheap call', async () => {
    const ok = makeCtx(SECRETS, fakeFetch({ 'GET api.teller.io/accounts': { json: [] } }));
    expect(await tellerAdapter.checkHealth?.(ok, makeConnection('teller'))).toBe('healthy');
    const expired = makeCtx(SECRETS, fakeFetch({ 'GET api.teller.io/accounts': { status: 401 } }));
    expect(await tellerAdapter.checkHealth?.(expired, makeConnection('teller'))).toBe(
      'needs_repair',
    );
  });
});
