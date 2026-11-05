import { describe, expect, it } from 'vitest';
import { redbarkAdapter } from '../src/adapters/redbark';
import { describeBankSuite } from './helpers/bankSuite';
import { fakeFetch, fixture, makeConnection, makeCtx, type FakeCall } from './helpers/fakeFetch';

const SECRETS = { REDBARK_API_KEY: 'rb-demo-key' };
const H = 'api.redbark.com/v1';

function ctx(variant: 'default' | 'posted' = 'default') {
  return makeCtx(
    SECRETS,
    fakeFetch({
      [`GET ${H}/accounts`]: (call: FakeCall) => ({
        json:
          call.url.searchParams.get('offset') === '0'
            ? fixture('redbark', 'accounts_page1.json')
            : fixture('redbark', 'accounts_page2.json'),
      }),
      [`GET ${H}/balances`]: { json: fixture('redbark', 'balances.json') },
      [`GET ${H}/transactions`]: (call: FakeCall) => ({
        json:
          call.url.searchParams.get('accountId') === 'rb-1'
            ? fixture(
                'redbark',
                variant === 'posted' ? 'transactions_posted.json' : 'transactions_1.json',
              )
            : fixture('redbark', 'transactions_2.json'),
      }),
      [`GET ${H}/connections`]: { json: fixture('redbark', 'connections.json') },
    }),
  );
}
const unauthorized = () =>
  makeCtx(
    SECRETS,
    fakeFetch({
      [`GET ${H}/accounts`]: { status: 401, json: {} },
      [`GET ${H}/connections`]: { status: 401, json: {} },
    }),
  );

describeBankSuite({
  name: 'redbark',
  adapter: redbarkAdapter,
  ctx,
  accounts: {
    'rb-1': { type: 'checking', currency: 'AUD', balance: 152_035 },
    'rb-2': { type: 'credit_card', balance: 48_020, currency: 'AUD' },
  },
  transactions: {
    'rb-t-1': { amount: -5_420, merchantName: 'Coles', categoryHint: 'groceries' },
    'rb-t-2': { amount: 320_000 },
    'rb-t-pend': { amount: -999, pending: true },
    'rb-c-1': { amount: -8_990 },
    'rb-c-2': { amount: 30_000 },
  },
  identical: { date: '2026-10-30', amount: -450 },
  pending: { pendingId: 'rb-t-pend', postedId: 'rb-t-post' },
  repair: [unauthorized],
  health: { ok: () => ctx(), expired: unauthorized },
});

describe('redbark specifics', () => {
  it('sends the bearer key, pages accounts with limit and offset, and asks for pending rows', async () => {
    const fetch = fakeFetch({
      [`GET ${H}/accounts`]: (call: FakeCall) => ({
        json:
          call.url.searchParams.get('offset') === '0'
            ? fixture('redbark', 'accounts_page1.json')
            : fixture('redbark', 'accounts_page2.json'),
      }),
      [`GET ${H}/balances`]: { json: fixture('redbark', 'balances.json') },
      [`GET ${H}/transactions`]: { json: { data: [], hasMore: false } },
    });
    await redbarkAdapter.sync(makeCtx(SECRETS, fetch), makeConnection('redbark'));
    expect(fetch.calls[0]?.headers.Authorization).toBe('Bearer rb-demo-key');
    expect(
      fetch.calls
        .filter((c) => c.url.pathname.endsWith('/accounts'))
        .map((c) => c.url.searchParams.get('offset')),
    ).toEqual(['0', '1']);
    expect(
      fetch.calls
        .find((c) => c.url.pathname.endsWith('/transactions'))
        ?.url.searchParams.get('includePending'),
    ).toBe('true');
    expect(
      fetch.calls
        .find((c) => c.url.pathname.endsWith('/balances'))
        ?.url.searchParams.get('accountIds'),
    ).toBe('rb-1,rb-2');
  });

  it('keeps an account out of the result when its balance fetch returned nothing', async () => {
    const c = makeCtx(
      SECRETS,
      fakeFetch({
        [`GET ${H}/accounts`]: {
          json: {
            data: [
              { id: 'rb-1', connectionId: 'c', name: 'A', type: 'transaction', currency: 'AUD' },
            ],
            hasMore: false,
          },
        },
        [`GET ${H}/balances`]: { json: { data: [] } },
      }),
    );
    const result = await redbarkAdapter.sync(c, makeConnection('redbark'));
    expect(result.accounts).toEqual([]);
  });

  it('gives id-less rows a content id and tells identical ones apart', async () => {
    const { transactions } = await redbarkAdapter.sync(ctx(), makeConnection('redbark'));
    const idless = transactions.filter((t) => t.externalId.startsWith('pending_'));
    expect(idless).toHaveLength(2);
    expect(new Set(idless.map((t) => t.externalId)).size).toBe(2);
  });
});
