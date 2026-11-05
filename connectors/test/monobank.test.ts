import { describe, expect, it } from 'vitest';
import { monobankAdapter } from '../src/adapters/monobank';
import { ConnectorRateLimitedError } from '../src/errors';
import { describeBankSuite } from './helpers/bankSuite';
import { fakeFetch, fixture, makeConnection, makeCtx } from './helpers/fakeFetch';

const SECRETS = { MONOBANK_TOKEN: 'mono_token_demo' };
const H = 'api.monobank.ua/personal';

function ctx(variant: 'default' | 'posted' = 'default') {
  const file = (id: string): string =>
    id === 'mono-acc-uah'
      ? variant === 'posted'
        ? 'statement_posted.json'
        : 'statement_uah.json'
      : id === 'mono-acc-credit'
        ? 'statement_credit.json'
        : 'statement_usd.json';
  return makeCtx(
    SECRETS,
    fakeFetch({
      [`GET ${H}/client-info`]: { json: fixture('monobank', 'client_info.json') },
      [`GET ${H}/statement/mono-acc-uah/*`]: { json: fixture('monobank', file('mono-acc-uah')) },
      [`GET ${H}/statement/mono-acc-credit/*`]: {
        json: fixture('monobank', file('mono-acc-credit')),
      },
      [`GET ${H}/statement/mono-acc-usd/*`]: { json: fixture('monobank', file('mono-acc-usd')) },
    }),
  );
}
const unauthorized = () =>
  makeCtx(
    SECRETS,
    fakeFetch({
      [`GET ${H}/client-info`]: {
        status: 403,
        json: fixture('monobank', 'error_unauthorized.json'),
      },
    }),
  );

describeBankSuite({
  name: 'monobank',
  adapter: monobankAdapter,
  ctx,
  accounts: {
    'mono-acc-uah': { type: 'checking', balance: 1_250_075, currency: 'UAH', mask: '1234' },
    'mono-acc-credit': { type: 'credit_card', balance: 30_000, creditLimit: 100_000 }, // limit 1000.00 - balance 700.00 = 300.00 owed
    'mono-acc-usd': { balance: 20_500, currency: 'USD' },
  },
  transactions: {
    'm-1': { amount: -15_600, date: '2026-11-02', pending: false },
    'm-2': { amount: 4_500_000 },
    'm-3': { amount: -8_800, pending: true },
    'm-u1': { amount: -1_500, originalAmount: -1_380, originalCurrency: 'EUR', currency: 'USD' },
  },
  identical: { date: '2026-10-30', amount: -4_500 },
  pending: { pendingId: 'm-3', postedId: 'm-9' },
  repair: [unauthorized],
  health: { ok: () => ctx(), expired: unauthorized },
});

describe('monobank specifics', () => {
  it('sends the X-Token header and asks for at most the last 31 days', async () => {
    const fetch = fakeFetch({
      [`GET ${H}/client-info`]: { json: fixture('monobank', 'client_info.json') },
      [`GET ${H}/statement/*`]: { json: [] },
    });
    await monobankAdapter.sync(makeCtx(SECRETS, fetch), makeConnection('monobank'));
    const statement = fetch.calls.find((x) => x.url.pathname.includes('/statement/'));
    expect(statement?.headers['X-Token']).toBe('mono_token_demo');
    const [, , , , from, to] = (statement?.url.pathname ?? '').split('/');
    expect(Number(to) - Number(from)).toBeLessThanOrEqual(31 * 86_400);
  });

  it('treats 429 as try-later, not repair', async () => {
    const limited = makeCtx(
      SECRETS,
      fakeFetch({
        [`GET ${H}/client-info`]: { status: 429, json: {}, headers: { 'retry-after': '60' } },
      }),
    );
    await expect(monobankAdapter.sync(limited, makeConnection('monobank'))).rejects.toBeInstanceOf(
      ConnectorRateLimitedError,
    );
  });
});
