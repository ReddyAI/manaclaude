import { describe, expect, it } from 'vitest';
import { akahuAdapter } from '../src/adapters/akahu';
import { describeBankSuite } from './helpers/bankSuite';
import { fakeFetch, fixture, makeConnection, makeCtx, type FakeCall } from './helpers/fakeFetch';

const SECRETS = { AKAHU_APP_TOKEN: 'app_token_demo', AKAHU_USER_TOKEN: 'user_token_demo' };
const H = 'api.akahu.io/v1';

function ctx(variant: 'default' | 'posted' = 'default') {
  return makeCtx(
    SECRETS,
    fakeFetch({
      [`GET ${H}/accounts`]: { json: fixture('akahu', 'accounts.json') },
      [`GET ${H}/accounts/acc_ak_chk/transactions`]: (call: FakeCall) => ({
        json:
          variant === 'posted'
            ? fixture('akahu', 'transactions_chk_posted.json')
            : call.url.searchParams.get('cursor') === 'cur_2'
              ? fixture('akahu', 'transactions_chk_page2.json')
              : fixture('akahu', 'transactions_chk_page1.json'),
      }),
      [`GET ${H}/accounts/acc_ak_card/transactions`]: {
        json: fixture('akahu', 'transactions_card.json'),
      },
      [`GET ${H}/transactions/pending`]: {
        json: fixture('akahu', variant === 'posted' ? 'pending_none.json' : 'pending.json'),
      },
      [`GET ${H}/me`]: { json: { success: true } },
    }),
  );
}
const unauthorized = () =>
  makeCtx(
    SECRETS,
    fakeFetch({
      [`GET ${H}/accounts`]: { status: 401, json: fixture('akahu', 'error_unauthorized.json') },
      [`GET ${H}/me`]: { status: 401, json: {} },
    }),
  );

describeBankSuite({
  name: 'akahu',
  adapter: akahuAdapter,
  ctx,
  accounts: {
    acc_ak_chk: { type: 'checking', balance: 152_035, availableBalance: 150_035, currency: 'NZD' },
    acc_ak_card: { type: 'credit_card', balance: 48_020, creditLimit: 500_000, mask: '1180' },
  },
  transactions: {
    trans_ak_1: {
      amount: -4_560,
      date: '2026-11-03',
      merchantName: 'Countdown',
      categoryHint: 'Groceries',
    },
    trans_ak_2: { amount: 240_000 },
    trans_ak_c1: { amount: -8_990 },
    trans_ak_c2: { amount: 30_000 },
  },
  identical: { date: '2026-10-30', amount: -550 },
  pending: { pendingId: 'pending_acc_ak_chk_2026_11_04_9_99_STREAMBOX', postedId: 'trans_ak_9' },
  repair: [unauthorized],
  health: { ok: () => ctx(), expired: unauthorized },
});

describe('akahu specifics', () => {
  it('sends both tokens and follows the cursor', async () => {
    const fetch = fakeFetch({
      [`GET ${H}/accounts`]: { json: fixture('akahu', 'accounts.json') },
      [`GET ${H}/accounts/acc_ak_chk/transactions`]: (call: FakeCall) => ({
        json:
          call.url.searchParams.get('cursor') === 'cur_2'
            ? fixture('akahu', 'transactions_chk_page2.json')
            : fixture('akahu', 'transactions_chk_page1.json'),
      }),
      [`GET ${H}/accounts/acc_ak_card/transactions`]: {
        json: fixture('akahu', 'transactions_card.json'),
      },
      [`GET ${H}/transactions/pending`]: { json: fixture('akahu', 'pending_none.json') },
    });
    await akahuAdapter.sync(makeCtx(SECRETS, fetch), makeConnection('akahu'));
    expect(fetch.calls[0]?.headers['X-Akahu-Id']).toBe('app_token_demo');
    expect(fetch.calls[0]?.headers.Authorization).toBe('Bearer user_token_demo');
    const chk = fetch.calls.filter((c) => c.url.pathname.endsWith('/acc_ak_chk/transactions'));
    expect(chk.map((c) => c.url.searchParams.get('cursor'))).toEqual([null, 'cur_2']);
  });
});
