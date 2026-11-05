import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  liabilitySignView,
  mapSophtronType,
  sophtronAdapter,
  sophtronAuthHeader,
  sophtronAuthPath,
} from '../src/adapters/sophtron';
import { fakeFetch, fixture, makeConnection, makeCtx } from './helpers/fakeFetch';
import {
  expectRepairOnExpiredToken,
  expectRepeatSyncIsQuiet,
  expectSyncShape,
} from './helpers/contract';

// An invented access key: 32 random-looking bytes, base64 encoded.
const ACCESS_KEY = Buffer.from('demo-sophtron-access-key-0123456').toString('base64');
const SECRETS = {
  SOPHTRON_USER_ID: 'demo-user-0001',
  SOPHTRON_ACCESS_KEY: ACCESS_KEY,
  SOPHTRON_USER_INSTITUTION_ID: 'ui-555',
};
const H = 'api.sophtron.com';

function routes(refresh: 'ok' | 'mfa' = 'ok') {
  return {
    [`POST ${H}/api/UserInstitution/GetUserInstitutionAccounts`]: {
      json: fixture('sophtron', 'accounts.json'),
    },
    [`POST ${H}/api/Transaction/GetTransactionsByTransactionDate`]: (call: { body?: string }) => ({
      json:
        JSON.parse(call.body ?? '{}').AccountID === 'soph-acc-001'
          ? fixture('sophtron', 'transactions_001.json')
          : fixture('sophtron', 'transactions_002.json'),
    }),
    [`POST ${H}/api/UserInstitutionAccount/RefreshUserInstitutionAccount`]: {
      json: fixture('sophtron', refresh === 'ok' ? 'refresh_ok.json' : 'refresh_mfa.json'),
    },
  };
}

describe('sophtron adapter', () => {
  it('signs requests like Sure: HMAC-SHA256 over METHOD and the lower-cased last path segment', async () => {
    expect(sophtronAuthPath('/Transaction/GetTransactionsByTransactionDate')).toBe(
      '/gettransactionsbytransactiondate',
    );
    const header = await sophtronAuthHeader(
      'u1',
      ACCESS_KEY,
      'post',
      '/UserInstitution/GetUserInstitutionAccounts',
    );
    const expected = createHmac('sha256', Buffer.from(ACCESS_KEY, 'base64'))
      .update('POST\n/getuserinstitutionaccounts')
      .digest('base64');
    expect(header).toBe(`FIApiAUTH:u1:${expected}:/getuserinstitutionaccounts`);
  });

  it('sends the signature header on every call', async () => {
    const fetch = fakeFetch(routes());
    await sophtronAdapter.sync(makeCtx(SECRETS, fetch), makeConnection('sophtron'));
    for (const call of fetch.calls) {
      expect(call.headers.Authorization).toMatch(
        /^FIApiAUTH:demo-user-0001:[A-Za-z0-9+/=]+:\/[a-z]+$/,
      );
    }
  });

  it('maps accounts: card balance owed is positive, closed accounts are skipped', async () => {
    const result = await sophtronAdapter.sync(
      makeCtx(SECRETS, fakeFetch(routes())),
      makeConnection('sophtron'),
    );
    await expectSyncShape(result);
    expect(result.accounts.map((a) => a.externalId)).toEqual(['soph-acc-001', 'soph-acc-002']);
    expect(result.accounts[0]).toMatchObject({ type: 'checking', balance: 312_055, mask: '9876' });
    expect(result.accounts[1]).toMatchObject({
      type: 'credit_card',
      balance: 61_208,
      mask: '6604',
    });
  });

  it('honours a card balance sign override', async () => {
    const ctx = makeCtx({ ...SECRETS, SOPHTRON_CARD_BALANCE_SIGN: 'debt' }, fakeFetch(routes()));
    const result = await sophtronAdapter.sync(ctx, makeConnection('sophtron'));
    expect(result.accounts[1]?.balance).toBe(61_208);
    const credit = makeCtx(
      { ...SECRETS, SOPHTRON_CARD_BALANCE_SIGN: 'credit' },
      fakeFetch(routes()),
    );
    expect(
      (await sophtronAdapter.sync(credit, makeConnection('sophtron'))).accounts[1]?.balance,
    ).toBe(-61_208);
  });

  it('keeps provider signs: negative is money out, positive is money in', async () => {
    const { transactions } = await sophtronAdapter.sync(
      makeCtx(SECRETS, fakeFetch(routes())),
      makeConnection('sophtron'),
    );
    const byId = new Map(transactions.map((t) => [t.externalId, t]));
    expect(byId.get('t-1001')).toMatchObject({
      amount: -4_217,
      merchantName: 'Riverside Pharmacy',
      date: '2026-11-02',
    });
    expect(byId.get('t-1002')).toMatchObject({
      amount: 180_000,
      merchantName: null,
      rawName: 'ACME PAYROLL',
    });
    expect(byId.get('t-1003')?.pending).toBe(true);
    expect(byId.get('t-2002')?.amount).toBe(30_000);
  });

  it('asks for a date window, with a 60-day overlap once a cursor exists', async () => {
    const first = fakeFetch(routes());
    const r1 = await sophtronAdapter.sync(makeCtx(SECRETS, first), makeConnection('sophtron'));
    const body1 = JSON.parse(
      first.calls.find((c) => c.url.pathname.endsWith('GetTransactionsByTransactionDate'))?.body ??
        '{}',
    );
    expect(body1).toMatchObject({ StartDate: '2024-11-05', EndDate: '2026-11-06' });
    const second = fakeFetch(routes());
    await sophtronAdapter.sync(
      makeCtx(SECRETS, second),
      makeConnection('sophtron', { syncCursor: r1.nextCursor }),
    );
    const body2 = JSON.parse(
      second.calls.find((c) => c.url.pathname.endsWith('GetTransactionsByTransactionDate'))?.body ??
        '{}',
    );
    expect(body2.StartDate).toBe('2026-09-06');
    expect(second.calls.some((c) => c.url.pathname.endsWith('RefreshUserInstitutionAccount'))).toBe(
      true,
    );
    expect(first.calls.some((c) => c.url.pathname.endsWith('RefreshUserInstitutionAccount'))).toBe(
      false,
    );
  });

  it('repeat syncs add nothing', async () => {
    await expectRepeatSyncIsQuiet(sophtronAdapter, () => makeCtx(SECRETS, fakeFetch(routes())));
  });

  it('asks for repair on 401 and when the bank wants a security answer', async () => {
    await expectRepairOnExpiredToken(sophtronAdapter, () =>
      makeCtx(
        SECRETS,
        fakeFetch({
          [`POST ${H}/api/UserInstitution/GetUserInstitutionAccounts`]: { status: 401 },
        }),
      ),
    );
    await expectRepairOnExpiredToken(
      sophtronAdapter,
      () => makeCtx(SECRETS, fakeFetch(routes('mfa'))),
      makeConnection('sophtron', { syncCursor: '{"since":"2026-11-01"}' }),
    );
  });

  it('guesses account types from the provider text', () => {
    expect(mapSophtronType('CreditCard', undefined).type).toBe('credit_card');
    expect(mapSophtronType('Investment', '401k').type).toBe('retirement');
    expect(mapSophtronType('Savings', undefined).type).toBe('savings');
    expect(mapSophtronType(undefined, undefined).type).toBe('checking');
  });

  describe('card and loan signs (Sure issues 3252 and 4350)', () => {
    const bankRoutes = () => ({
      [`POST ${H}/api/UserInstitution/GetUserInstitutionAccounts`]: {
        json: fixture('sophtron', 'accounts_bank_view.json'),
      },
      [`POST ${H}/api/Transaction/GetTransactionsByTransactionDate`]: (call: { body?: string }) => {
        const id = JSON.parse(call.body ?? '{}').AccountID as string;
        if (id === 'soph-acc-101')
          return { json: fixture('sophtron', 'transactions_101_bank_view.json') };
        if (id === 'soph-acc-102')
          return { json: fixture('sophtron', 'transactions_102_bank_view.json') };
        return { json: { Transactions: [] } };
      },
      [`POST ${H}/api/UserInstitutionAccount/RefreshUserInstitutionAccount`]: {
        json: fixture('sophtron', 'refresh_ok.json'),
      },
    });

    it('a bank that reports purchases as positive: purchases become spending, payments arrive', async () => {
      const result = await sophtronAdapter.sync(
        makeCtx(SECRETS, fakeFetch(bankRoutes())),
        makeConnection('sophtron'),
      );
      const byId = new Map(result.transactions.map((t) => [t.externalId, t.amount]));
      expect(byId.get('t-10101')).toBe(-6_420);
      expect(byId.get('t-10102')).toBe(-1_250);
      expect(byId.get('t-10103')).toBe(50_000);
      // owed balance reported as positive stays positive (owed)
      expect(result.accounts.find((a) => a.externalId === 'soph-acc-101')?.balance).toBe(194_718);
    });

    it('a loan in the bank ledger: payments arrive (positive), interest leaves (negative), balance owed', async () => {
      const result = await sophtronAdapter.sync(
        makeCtx(SECRETS, fakeFetch(bankRoutes())),
        makeConnection('sophtron'),
      );
      const byId = new Map(result.transactions.map((t) => [t.externalId, t.amount]));
      expect(byId.get('t-10201')).toBe(35_000);
      expect(byId.get('t-10203')).toBe(-6_140);
      const loan = result.accounts.find((a) => a.externalId === 'soph-acc-102');
      expect(loan).toMatchObject({ type: 'loan', balance: 1_500_000 });
    });

    it('a card with no rows yet counts its balance as owed, then keeps the last answer from the cursor', async () => {
      const first = await sophtronAdapter.sync(
        makeCtx(SECRETS, fakeFetch(bankRoutes())),
        makeConnection('sophtron'),
      );
      expect(first.accounts.find((a) => a.externalId === 'soph-acc-103')?.balance).toBe(25_000);
      expect(JSON.parse(first.nextCursor ?? '{}').liabilitySigns).toMatchObject({
        'soph-acc-101': 'bank',
        'soph-acc-102': 'bank',
      });
      // Next month card 101 has no rows; the saved answer still applies (a credit balance stays negative).
      const quiet = {
        ...bankRoutes(),
        [`POST ${H}/api/UserInstitution/GetUserInstitutionAccounts`]: {
          json: {
            Accounts: [
              {
                AccountID: 'soph-acc-101',
                AccountName: 'Cashback Card',
                AccountType: 'CreditCard',
                AccountBalance: -20.0,
                BalanceCurrency: 'USD',
              },
            ],
          },
        },
        [`POST ${H}/api/Transaction/GetTransactionsByTransactionDate`]: {
          json: { Transactions: [] },
        },
      };
      const second = await sophtronAdapter.sync(
        makeCtx(SECRETS, fakeFetch(quiet)),
        makeConnection('sophtron', { syncCursor: first.nextCursor }),
      );
      expect(second.accounts[0]?.balance).toBe(-2_000);
    });

    it('the customer view (the existing fixture) is left as it is', async () => {
      const result = await sophtronAdapter.sync(
        makeCtx(SECRETS, fakeFetch(routes())),
        makeConnection('sophtron'),
      );
      const byId = new Map(result.transactions.map((t) => [t.externalId, t.amount]));
      expect(byId.get('t-2001')).toBe(-12_000);
      expect(byId.get('t-2002')).toBe(30_000);
      expect(JSON.parse(result.nextCursor ?? '{}').liabilitySigns).toEqual({
        'soph-acc-002': 'customer',
      });
    });

    it('SOPHTRON_LIABILITY_SIGNS overrides the guess', async () => {
      const result = await sophtronAdapter.sync(
        makeCtx({ ...SECRETS, SOPHTRON_LIABILITY_SIGNS: 'customer' }, fakeFetch(bankRoutes())),
        makeConnection('sophtron'),
      );
      const byId = new Map(result.transactions.map((t) => [t.externalId, t.amount]));
      expect(byId.get('t-10101')).toBe(6_420);
      expect(result.accounts.find((a) => a.externalId === 'soph-acc-101')?.balance).toBe(-194_718);
    });

    it('decides from Debit/Credit types first, then a payment row, then most rows', () => {
      expect(
        liabilitySignView('credit_card', [
          { amount: 20, type: 'Debit', text: 'SHOP' },
          { amount: -100, type: 'Credit', text: 'REFUND' },
        ]),
      ).toBe('bank');
      expect(
        liabilitySignView('credit_card', [
          { amount: -20, type: 'Debit', text: 'SHOP' },
          { amount: 100, type: 'Credit', text: 'PAYMENT' },
        ]),
      ).toBe('customer');
      expect(
        liabilitySignView('credit_card', [
          { amount: 5, text: 'A' },
          { amount: 6, text: 'B' },
          { amount: 300, text: 'AUTOPAY' },
        ]),
      ).toBe('customer');
      expect(
        liabilitySignView('credit_card', [
          { amount: 5, text: 'A' },
          { amount: 6, text: 'B' },
          { amount: -1, text: 'C' },
        ]),
      ).toBe('bank');
      expect(
        liabilitySignView('loan', [
          { amount: -350, text: 'X' },
          { amount: -350, text: 'Y' },
          { amount: 60, text: 'Z' },
        ]),
      ).toBe('bank');
      expect(liabilitySignView('loan', [])).toBeNull();
      expect(
        liabilitySignView('credit_card', [
          { amount: 5, text: 'A' },
          { amount: -5, text: 'B' },
        ]),
      ).toBeNull();
    });
  });
});
