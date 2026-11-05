import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
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
    expect(body1).toMatchObject({ StartDate: '2025-11-05', EndDate: '2026-11-06' });
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
});
