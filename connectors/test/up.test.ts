import { describe, expect, it } from 'vitest';
import { upAdapter } from '../src/adapters/up';
import { describeBankSuite } from './helpers/bankSuite';
import { fakeFetch, fixture, makeConnection, makeCtx, type FakeCall } from './helpers/fakeFetch';

const SECRETS = { UP_ACCESS_TOKEN: 'up:demo:token' };
const H = 'api.up.com.au/api/v1';

function ctx(variant: 'default' | 'posted' = 'default') {
  return makeCtx(
    SECRETS,
    fakeFetch({
      [`GET ${H}/accounts`]: { json: fixture('up', 'accounts.json') },
      [`GET ${H}/accounts/up-acc-spend/transactions`]: (call: FakeCall) => ({
        json:
          variant === 'posted'
            ? fixture('up', 'transactions_spend_posted.json')
            : call.url.searchParams.get('page[after]')
              ? fixture('up', 'transactions_spend_page2.json')
              : fixture('up', 'transactions_spend_page1.json'),
      }),
      [`GET ${H}/accounts/up-acc-saver/transactions`]: {
        json: fixture('up', 'transactions_empty.json'),
      },
      [`GET ${H}/accounts/up-acc-loan/transactions`]: {
        json: fixture('up', 'transactions_empty.json'),
      },
      [`GET ${H}/util/ping`]: { json: { meta: { id: 'x' } } },
    }),
  );
}
const unauthorized = () =>
  makeCtx(
    SECRETS,
    fakeFetch({
      [`GET ${H}/accounts`]: { status: 401, json: fixture('up', 'error_unauthorized.json') },
    }),
  );

describeBankSuite({
  name: 'up',
  adapter: upAdapter,
  ctx,
  accounts: {
    'up-acc-spend': { type: 'checking', balance: 231_045, currency: 'AUD' },
    'up-acc-saver': { type: 'savings', balance: 120_000 },
    'up-acc-loan': { type: 'mortgage', balance: 25_000_000 }, // owed, positive
  },
  transactions: {
    'up-t-1': {
      amount: -650,
      pending: true,
      date: '2026-11-04',
      merchantName: 'Blue Bean Cafe',
      rawName: 'BLUE BEAN CAFE SYDNEY',
    },
    'up-t-2': { amount: 320_000, pending: false, date: '2026-11-02' },
    'up-t-6': { amount: -6_840, originalAmount: -4_000, originalCurrency: 'EUR' },
  },
  identical: { date: '2026-10-30', amount: -5_420 },
  pending: { pendingId: 'up-t-1', postedId: 'up-t-9' },
  repair: [unauthorized],
  health: { ok: () => ctx(), expired: unauthorized },
});

describe('up specifics', () => {
  it('follows links.next and sends the bearer token', async () => {
    const fetch = fakeFetch({
      [`GET ${H}/accounts`]: { json: fixture('up', 'accounts.json') },
      [`GET ${H}/accounts/up-acc-spend/transactions`]: (call: FakeCall) => ({
        json: call.url.searchParams.get('page[after]')
          ? fixture('up', 'transactions_spend_page2.json')
          : fixture('up', 'transactions_spend_page1.json'),
      }),
      [`GET ${H}/accounts/up-acc-saver/transactions`]: {
        json: fixture('up', 'transactions_empty.json'),
      },
      [`GET ${H}/accounts/up-acc-loan/transactions`]: {
        json: fixture('up', 'transactions_empty.json'),
      },
    });
    const result = await upAdapter.sync(makeCtx(SECRETS, fetch), makeConnection('up'));
    expect(fetch.calls[0]?.headers.Authorization).toBe('Bearer up:demo:token');
    expect(result.transactions.filter((t) => t.accountExternalId === 'up-acc-spend')).toHaveLength(
      6,
    );
  });

  it('marks movements between own accounts (round-ups) as transfers', async () => {
    const result = await upAdapter.sync(ctx(), makeConnection('up'));
    expect(result.transactions.find((t) => t.externalId === 'up-t-5')?.kindHint).toBe('transfer');
    expect(result.transactions.find((t) => t.externalId === 'up-t-1')?.kindHint ?? null).toBeNull();
  });
});
