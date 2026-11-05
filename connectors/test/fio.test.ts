import { describe, expect, it } from 'vitest';
import { fioAdapter } from '../src/adapters/fio';
import { describeBankSuite } from './helpers/bankSuite';
import { fakeFetch, fixture, makeConnection, makeCtx } from './helpers/fakeFetch';

const SECRETS = { FIO_TOKEN: 'DemoFioToken0123456789' };
const H = 'fioapi.fio.cz/v1/rest';

const ctx = () =>
  makeCtx(
    SECRETS,
    fakeFetch({
      [`GET ${H}/periods/DemoFioToken0123456789/*`]: {
        json: fixture('fio', 'statement.json'),
      },
    }),
  );
const rejected = () =>
  makeCtx(
    SECRETS,
    fakeFetch({
      [`GET ${H}/periods/DemoFioToken0123456789/*`]: {
        status: 500,
        json: fixture('fio', 'error_invalid.json'),
      },
    }),
  );

describeBankSuite({
  name: 'fio',
  adapter: fioAdapter,
  ctx,
  accounts: {
    '2100123456/2010': { type: 'checking', currency: 'CZK', balance: 4_521_075, mask: '3456' },
  },
  transactions: {
    '26000000001': {
      amount: -34_950,
      date: '2026-11-03',
      merchantName: 'Albert Praha',
      rawName: 'Albert Praha - Platba kartou',
    },
    '26000000002': { amount: 3_200_000, rawName: 'Acme s.r.o. - Mzda 10/2026' },
  },
  identical: { date: '2026-10-30', amount: -8_900 },
  repair: [rejected],
});

describe('fio specifics', () => {
  it('puts the token in the path and reads from the cursor date with an overlap', async () => {
    const fetch = fakeFetch({
      [`GET ${H}/periods/DemoFioToken0123456789/2026-10-29/2026-11-05/transactions.json`]: {
        json: fixture('fio', 'statement.json'),
      },
    });
    await fioAdapter.sync(
      makeCtx(SECRETS, fetch),
      makeConnection('fio', { syncCursor: '{"since":"2026-11-05"}' }),
    );
    expect(fetch.calls[0]?.url.pathname).toContain(
      '/periods/DemoFioToken0123456789/2026-10-29/2026-11-05/',
    );
  });

  it('treats an empty transaction list as no new rows', async () => {
    const body = {
      accountStatement: {
        info: { accountId: '2100123456', bankId: '2010', currency: 'CZK', closingBalance: 10 },
        transactionList: null,
      },
    };
    const c = makeCtx(
      SECRETS,
      fakeFetch({
        [`GET ${H}/periods/DemoFioToken0123456789/*`]: {
          json: body,
        },
      }),
    );
    const result = await fioAdapter.sync(c, makeConnection('fio'));
    expect(result.transactions).toEqual([]);
    expect(result.accounts[0]?.balance).toBe(1_000);
  });
});
