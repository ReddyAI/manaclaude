import { describe, expect, it } from 'vitest';
import { isSimplefinPending, parseAccessUrl, simplefinAdapter } from '../src/adapters/simplefin';
import { inferAccountType, normalizeLiabilityBalance } from '../src/util/accountTypes';
import { fakeFetch, fixture, makeConnection, makeCtx, type FakeCall } from './helpers/fakeFetch';
import {
  expectRepairOnExpiredToken,
  expectRepeatSyncIsQuiet,
  expectSyncShape,
} from './helpers/contract';
import { MemoryStore } from './helpers/store';

const SECRETS = {
  SIMPLEFIN_ACCESS_URL: 'https://demouser:demopass@bridge.example.invalid/simplefin',
};
const H = 'bridge.example.invalid/simplefin/accounts';

const ctxFor = (name = 'accounts.json') =>
  makeCtx(SECRETS, fakeFetch({ [`GET ${H}`]: { json: fixture('simplefin', name) } }));

describe('simplefin adapter', () => {
  it('moves the credentials from the access URL into a Basic header', async () => {
    expect(parseAccessUrl(SECRETS.SIMPLEFIN_ACCESS_URL).baseUrl).toBe(
      'https://bridge.example.invalid/simplefin',
    );
    const fetch = fakeFetch({ [`GET ${H}`]: { json: fixture('simplefin', 'accounts.json') } });
    await simplefinAdapter.sync(makeCtx(SECRETS, fetch), makeConnection('simplefin'));
    const call = fetch.calls[0] as FakeCall;
    expect(call.url.username).toBe('');
    expect(atob((call.headers.Authorization ?? '').replace('Basic ', ''))).toBe(
      'demouser:demopass',
    );
    expect(call.url.searchParams.get('pending')).toBe('1');
    expect(call.url.searchParams.get('version')).toBe('2');
    expect(Number(call.url.searchParams.get('start-date'))).toBe(
      Math.floor(Date.parse('2026-08-07T00:00:00Z') / 1000),
    );
  });

  it('infers account types and puts card debt in the model sign', async () => {
    const result = await simplefinAdapter.sync(ctxFor(), makeConnection('simplefin'));
    await expectSyncShape(result);
    const byId = new Map(result.accounts.map((a) => [a.externalId, a]));
    expect(byId.get('ACT-chk-01')).toMatchObject({ type: 'checking', balance: 312_055 });
    // Balance -612.08 with available credit +4387.92: the card owes 612.08.
    expect(byId.get('ACT-card-01')).toMatchObject({ type: 'credit_card', balance: 61_208 });
    expect(byId.get('ACT-inv-01')).toMatchObject({ type: 'brokerage', balance: 705_000 });
  });

  it('honours a card balance sign override', async () => {
    const ctx = makeCtx(
      { ...SECRETS, SIMPLEFIN_CARD_BALANCE_SIGN: 'credit' },
      fakeFetch({ [`GET ${H}`]: { json: fixture('simplefin', 'accounts.json') } }),
    );
    const result = await simplefinAdapter.sync(ctx, makeConnection('simplefin'));
    expect(result.accounts.find((a) => a.externalId === 'ACT-card-01')?.balance).toBe(-61_208);
  });

  it('keeps SimpleFIN signs and dates cards by purchase day', async () => {
    const { transactions } = await simplefinAdapter.sync(ctxFor(), makeConnection('simplefin'));
    const byId = new Map(transactions.map((t) => [t.externalId, t]));
    expect(byId.get('SF-1001')).toMatchObject({
      amount: -4_217,
      date: '2026-11-02',
      merchantName: 'Riverside Pharmacy',
      rawName: 'Riverside Pharmacy - RIVERSIDE PHARMACY #22',
    });
    expect(byId.get('SF-1002')?.amount).toBe(180_000);
    expect(byId.get('SF-2001')).toMatchObject({ amount: -12_000, date: '2026-10-30' }); // transacted_at, not posted
    expect(byId.get('SF-2002')?.amount).toBe(30_000);
  });

  it('flags pending rows, including posted=0 with a transacted date', async () => {
    const { transactions } = await simplefinAdapter.sync(ctxFor(), makeConnection('simplefin'));
    expect(transactions.find((t) => t.externalId === 'SF-1003')?.pending).toBe(true);
    expect(isSimplefinPending({ posted: 0, transacted_at: 1793793600 })).toBe(true);
    expect(isSimplefinPending({ posted: 1793620800 })).toBe(false);
  });

  it('reads holdings, giving a custom ticker to ones without a symbol', async () => {
    const { holdings } = await simplefinAdapter.sync(ctxFor(), makeConnection('simplefin'));
    expect(holdings.find((h) => h.symbol === 'VTI')).toMatchObject({
      quantity: '25',
      price: '280',
      costBasis: 500_000,
    });
    expect(holdings.find((h) => h.symbol.startsWith('CUSTOM:'))?.name).toBe('Private Note 2030');
  });

  it('matches the posted row to the pending hold by amount (new id, no link)', async () => {
    const store = new MemoryStore();
    const conn = makeConnection('simplefin');
    store.apply(conn, await simplefinAdapter.sync(ctxFor(), conn));
    const hold = store.transactions.find((t) => t.externalId === 'SF-1003');
    expect(hold?.pending).toBe(true);
    const next = await simplefinAdapter.sync(ctxFor('accounts_posted.json'), conn);
    const { txn } = store.apply(conn, next, '2026-11-06T12:00:00.000Z');
    expect(txn.stats.postedFromPending).toBe(1);
    expect(store.transactions.find((t) => t.id === hold?.id)).toMatchObject({
      externalId: 'SF-1099',
      pending: false,
      pendingExternalId: 'SF-1003',
    });
  });

  it('keeps two identical coffees and is quiet on a repeat sync', async () => {
    const { store } = await expectRepeatSyncIsQuiet(simplefinAdapter, () => ctxFor());
    expect(
      store.transactions.filter((t) => t.date === '2026-10-29' && t.amount === -450),
    ).toHaveLength(2);
  });

  it('asks for repair on 403, 402 and a sign-in message with no accounts', async () => {
    for (const status of [403, 402]) {
      await expectRepairOnExpiredToken(simplefinAdapter, () =>
        makeCtx(SECRETS, fakeFetch({ [`GET ${H}`]: { status, json: {} } })),
      );
    }
    await expectRepairOnExpiredToken(simplefinAdapter, () => ctxFor('accounts_empty_auth.json'));
  });

  it("ports Sure's name rules and liability sign rule", () => {
    expect(inferAccountType({ name: 'Roth IRA' })).toMatchObject({
      type: 'retirement',
      subtype: 'roth_ira',
    });
    expect(inferAccountType({ name: 'My 401k' }).subtype).toBe('401k');
    expect(inferAccountType({ name: 'Auto Loan' }).type).toBe('loan');
    expect(
      inferAccountType({ name: 'Plain Account', balance: -10, availableBalance: 500 }).type,
    ).toBe('credit_card');
    expect(inferAccountType({ name: 'Mystery' })).toMatchObject({
      type: 'checking',
      confidence: 'low',
    });
    expect(normalizeLiabilityBalance(500, 500, 9500)).toBe(-500); // both positive: a credit balance
    expect(normalizeLiabilityBalance(-500, -500, -100)).toBe(500);
    expect(normalizeLiabilityBalance(-612.08, -612.08, 4387.92)).toBe(612.08);
  });
});
