import { beforeAll, describe, expect, it } from 'vitest';
import { enableBankingAdapter, pickBalance } from '../src/adapters/enable_banking';
import { fromBase64, toBase64 } from '../src/util/crypto';
import { describeBankSuite } from './helpers/bankSuite';
import { expectRepairOnExpiredToken } from './helpers/contract';
import { fakeFetch, fixture, makeConnection, makeCtx, type FakeCall } from './helpers/fakeFetch';

const H = 'api.enablebanking.com';
let SECRETS: Record<string, string> = {};
let publicKey: CryptoKey;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  publicKey = pair.publicKey;
  SECRETS = {
    ENABLEBANKING_APPLICATION_ID: 'app-id-demo',
    ENABLEBANKING_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${toBase64(pkcs8)}\n-----END PRIVATE KEY-----`,
    ENABLEBANKING_SESSION_ID: 'eb-session-demo',
  };
});

function routes(variant: 'default' | 'posted' = 'default', over: Record<string, unknown> = {}) {
  return {
    [`GET ${H}/sessions/eb-session-demo`]: { json: fixture('enable_banking', 'session.json') },
    [`GET ${H}/accounts/eb-acc-1/balances`]: { json: fixture('enable_banking', 'balances_1.json') },
    [`GET ${H}/accounts/eb-acc-2/balances`]: { json: fixture('enable_banking', 'balances_2.json') },
    [`GET ${H}/accounts/eb-acc-1/transactions`]: (call: FakeCall) => {
      const status = call.url.searchParams.get('transaction_status');
      if (status === 'PDNG')
        return {
          json: fixture(
            'enable_banking',
            variant === 'posted' ? 'tx_empty.json' : 'tx_1_pending.json',
          ),
        };
      if (variant === 'posted') return { json: fixture('enable_banking', 'tx_1_book_posted.json') };
      return {
        json: fixture(
          'enable_banking',
          call.url.searchParams.get('continuation_key')
            ? 'tx_1_book_page2.json'
            : 'tx_1_book_page1.json',
        ),
      };
    },
    [`GET ${H}/accounts/eb-acc-2/transactions`]: (call: FakeCall) => ({
      json: fixture(
        'enable_banking',
        call.url.searchParams.get('transaction_status') === 'PDNG'
          ? 'tx_empty.json'
          : 'tx_2_book.json',
      ),
    }),
    ...over,
  };
}
const ctx = (variant: 'default' | 'posted' = 'default') =>
  makeCtx(SECRETS, fakeFetch(routes(variant)));
const expired = () =>
  makeCtx(
    SECRETS,
    fakeFetch(
      routes('default', {
        [`GET ${H}/sessions/eb-session-demo`]: {
          json: fixture('enable_banking', 'session_expired.json'),
        },
      }),
    ),
  );

describeBankSuite({
  name: 'enable banking',
  adapter: enableBankingAdapter,
  ctx,
  accounts: {
    'eb-acc-1': {
      type: 'checking',
      currency: 'EUR',
      balance: 152_035,
      institutionName: 'Nordic Demo Bank',
      mask: '1234',
    },
    'eb-acc-2': { type: 'credit_card', balance: 48_020 }, // -480.20 reported, 480.20 owed
  },
  transactions: {
    'EB-1': {
      amount: -4_560,
      merchantName: 'K-Market',
      rawName: 'K-MARKET HELSINKI',
      pending: false,
    },
    'EB-2': { amount: 240_000, merchantName: 'Acme Oy' },
    'EB-PEND-1': { amount: -999, pending: true, date: '2026-11-04' },
    'EB-C1': { amount: -12_000 },
    'EB-C2': { amount: 30_000 },
  },
  identical: { date: '2026-10-30', amount: -550 },
  pending: { pendingId: 'EB-PEND-1', postedId: 'EB-9' },
  repair: [
    expired,
    () =>
      makeCtx(
        SECRETS,
        fakeFetch(
          routes('default', {
            [`GET ${H}/accounts/eb-acc-1/balances`]: {
              status: 403,
              json: fixture('enable_banking', 'error_expired.json'),
            },
          }),
        ),
      ),
  ],
  health: { ok: () => ctx(), expired },
});

describe('enable banking specifics', () => {
  it('signs a one-hour RS256 JWT with the application id as kid', async () => {
    const fetch = fakeFetch(routes());
    await enableBankingAdapter.sync(makeCtx(SECRETS, fetch), makeConnection('enable_banking'));
    const jwt = (fetch.calls[0]?.headers.Authorization ?? '').replace('Bearer ', '');
    const [h, p, s] = jwt.split('.') as [string, string, string];
    const decode = (x: string) => JSON.parse(atob(x.replace(/-/g, '+').replace(/_/g, '/')));
    expect(decode(h)).toMatchObject({ alg: 'RS256', typ: 'JWT', kid: 'app-id-demo' });
    expect(decode(p)).toMatchObject({ iss: 'enablebanking.com', aud: 'api.enablebanking.com' });
    expect(decode(p).exp - decode(p).iat).toBe(3600);
    expect(
      await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        publicKey,
        fromBase64(s),
        new TextEncoder().encode(`${h}.${p}`),
      ),
    ).toBe(true);
  });

  it('follows continuation keys and asks for booked and pending rows separately', async () => {
    const fetch = fakeFetch(routes());
    await enableBankingAdapter.sync(makeCtx(SECRETS, fetch), makeConnection('enable_banking'));
    const calls = fetch.calls
      .filter((c) => c.url.pathname === '/accounts/eb-acc-1/transactions')
      .map((c) => [
        c.url.searchParams.get('transaction_status'),
        c.url.searchParams.get('continuation_key'),
      ]);
    expect(calls).toEqual([
      ['BOOK', null],
      ['BOOK', 'page-2'],
      ['PDNG', null],
    ]);
  });

  it('picks balances by type priority, newest first within a type', () => {
    const b = (balance_type: string, amount: string, reference_date = '2026-11-01') => ({
      balance_type,
      balance_amount: { currency: 'EUR', amount },
      reference_date,
    });
    expect(
      pickBalance([b('ITAV', '1'), b('CLBD', '2'), b('XPCD', '3')])?.balance_amount.amount,
    ).toBe('2');
    expect(
      pickBalance([b('CLBD', '2', '2026-10-01'), b('CLBD', '5', '2026-11-01')])?.balance_amount
        .amount,
    ).toBe('5');
    expect(pickBalance([b('ZZZZ', '9')])?.balance_amount.amount).toBe('9');
    expect(pickBalance([])).toBeUndefined();
  });

  it('asks for repair when the consent has lapsed even though the session says AUTHORIZED', async () => {
    await expectRepairOnExpiredToken(enableBankingAdapter, () =>
      makeCtx(
        SECRETS,
        fakeFetch(
          routes('default', {
            [`GET ${H}/sessions/eb-session-demo`]: {
              json: fixture('enable_banking', 'session_lapsed.json'),
            },
          }),
        ),
      ),
    );
  });

  it('treats a rejected application JWT (401) as a setup problem, not a repair', async () => {
    const c = makeCtx(
      SECRETS,
      fakeFetch(
        routes('default', { [`GET ${H}/sessions/eb-session-demo`]: { status: 401, json: {} } }),
      ),
    );
    await expect(
      enableBankingAdapter.sync(c, makeConnection('enable_banking')),
    ).rejects.toMatchObject({ name: 'ProviderHttpError', status: 401 });
  });
});
