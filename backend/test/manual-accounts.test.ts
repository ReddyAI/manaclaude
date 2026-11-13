import { beforeEach, describe, expect, it } from 'vitest';
import {
  ACCOUNT_TYPES,
  type Account,
  type BalanceSnapshot,
  type ImportResponse,
} from '@manaclaude/shared';
import { selectAll } from '../src/db/table';
import { accountsTable, balanceSnapshotsTable } from '../src/db/tables';
import { meterDb } from '../src/db/meter';
import {
  createManualAccount,
  manualAccountSchema,
  type AccountWithManualBalance,
  type CreateManualAccountRequest,
  type CreateManualAccountResponse,
} from '../src/services/accounts';
import { allTxns, db, freshDb, testEnv } from './helpers';
import { client, upload } from './worker';

beforeEach(freshDb);
const now = '2026-11-12T12:00:00.000Z';
const clock = () => new Date(now);
const path = '/v1/accounts/manual';
const request = (
  changes: Partial<CreateManualAccountRequest> = {},
): CreateManualAccountRequest => ({
  idempotencyKey: 'invented-account-attempt',
  name: 'Orchard savings',
  type: 'savings',
  subtype: 'nre',
  currency: 'INR',
  openingBalance: { amount: 20_000, date: '2025-01-01' },
  currentBalance: { amount: 45_000, asOf: now },
  ...changes,
});
const create = (body: unknown = request()) =>
  client({ now: clock }).api<CreateManualAccountResponse>('POST', path, body);

describe('manual account creation', () => {
  it.each(ACCOUNT_TYPES.filter((type) => type !== 'cash'))(
    'creates a %s without a provider',
    async (type) => {
      const result = await create(request({ type, subtype: type === 'savings' ? 'nro' : null }));
      expect(result.status).toBe(201);
      expect(result.body.replayed).toBe(false);
      expect(result.body.account).toMatchObject({
        type,
        name: 'Orchard savings',
        currency: 'INR',
        balance: 45_000,
        balanceAsOf: now,
        openedOn: '2025-01-01',
        connectionId: null,
        externalId: null,
        includeInNetWorth: true,
        isDefaultCash: false,
        createdAt: now,
        updatedAt: now,
        manualBalance: {
          currentKnown: true,
          openingBalance: { amount: 20_000, date: '2025-01-01' },
        },
      });
      expect(await allTxns()).toEqual([]);
      expect(await selectAll(db, balanceSnapshotsTable, '', [], 'date')).toEqual([
        { accountId: result.body.account.id, date: '2025-01-01', balance: 20_000, currency: 'INR' },
        { accountId: result.body.account.id, date: '2026-11-12', balance: 45_000, currency: 'INR' },
      ]);
    },
  );

  it('keeps opening-only balances separate from unknown current balances after reload', async () => {
    const result = await create(request({ currentBalance: null }));
    const expected = {
      id: result.body.account.id,
      balance: 0,
      balanceAsOf: now,
      includeInNetWorth: false,
      manualBalance: {
        currentKnown: false,
        openingBalance: { amount: 20_000, date: '2025-01-01' },
      },
    };
    expect(result.body.account).toMatchObject(expected);
    for (const url of ['/v1/accounts', '/v1/dataset']) {
      const reloaded = await client().api<{ accounts: AccountWithManualBalance[] }>('GET', url);
      expect(reloaded.body.accounts).toEqual([expect.objectContaining(expected)]);
    }
    expect(await selectAll(db, balanceSnapshotsTable)).toHaveLength(1);
  });

  it('allows wholly unknown balances without inventing snapshots, dates or transactions', async () => {
    const result = await create(
      request({ currentBalance: null, openingBalance: undefined, subtype: undefined }),
    );
    expect(result.body.account).toMatchObject({
      balance: 0,
      includeInNetWorth: false,
      openedOn: null,
      subtype: null,
      manualBalance: { currentKnown: false, openingBalance: null },
    });
    expect(await selectAll(db, balanceSnapshotsTable)).toEqual([]);
    expect(await allTxns()).toEqual([]);
  });

  it('distinguishes a confirmed zero from unknown and permits exclusion of known balances', async () => {
    const result = await create(
      request({ currentBalance: { amount: 0, asOf: now }, openingBalance: null }),
    );
    expect(result.body.account).toMatchObject({
      balance: 0,
      includeInNetWorth: true,
      manualBalance: { currentKnown: true },
    });
    const excluded = await create(
      request({ idempotencyKey: 'excluded', includeInNetWorth: false }),
    );
    expect(excluded.body.account.includeInNetWorth).toBe(false);
  });

  it('keeps a same-day opening reading but uses the current reading for the daily snapshot', async () => {
    const result = await create(
      request({ openingBalance: { amount: 12_300, date: '2026-11-12' } }),
    );
    expect(result.body.account.manualBalance?.openingBalance?.amount).toBe(12_300);
    expect(await selectAll(db, balanceSnapshotsTable)).toEqual([
      { accountId: result.body.account.id, date: '2026-11-12', balance: 45_000, currency: 'INR' },
    ]);
  });

  it('preserves signed asset/credit balances and positive debt without changing signs', async () => {
    for (const [type, amount] of [
      ['checking', -2_000],
      ['credit_card', 9_000],
      ['credit_card', -500],
    ] as const) {
      const result = await create(
        request({
          idempotencyKey: `${type}_${amount}`,
          type,
          currentBalance: { amount, asOf: now },
        }),
      );
      expect(result.body.account.balance).toBe(amount);
    }
  });
});

describe('manual account retry and atomicity', () => {
  it('replays normalized requests across clients/clocks without resetting later edits', async () => {
    const first = await create(
      request({
        name: '  Orchard savings  ',
        subtype: ' nre ',
        currentBalance: { amount: 45_000, asOf: '2026-11-12T12:00:00Z' },
      }),
    );
    await db
      .prepare('UPDATE accounts SET name = ?, balance = ?, updated_at = ? WHERE id = ?')
      .bind('Edited name', 50_000, '2026-11-13T12:00:00.000Z', first.body.account.id)
      .run();
    const result = await client({
      now: () => new Date('2027-01-01T00:00:00Z'),
    }).api<CreateManualAccountResponse>('POST', path, request({ includeInNetWorth: true }));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      replayed: true,
      account: { id: first.body.account.id, name: 'Edited name', balance: 50_000 },
    });
    expect(await selectAll(db, accountsTable)).toHaveLength(1);
    expect(await selectAll(db, balanceSnapshotsTable)).toHaveLength(2);
  });

  it('creates once when identical requests overlap, including their snapshots', async () => {
    const results = await Promise.all([create(), create(), create()]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    expect(new Set(results.map((r) => r.body.account.id)).size).toBe(1);
    expect(await selectAll(db, accountsTable)).toHaveLength(1);
    expect(await selectAll(db, balanceSnapshotsTable)).toHaveLength(2);
  });

  it('rejects a reused key with changed details even during a race', async () => {
    const results = await Promise.all([create(), create(request({ currency: 'USD' }))]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)?.body).toMatchObject({
      error: 'idempotency_conflict',
    });
    expect(await selectAll(db, accountsTable)).toHaveLength(1);
    const repeat = await create(request({ currentBalance: null }));
    expect(repeat.status).toBe(409);
    expect(repeat.body).toMatchObject({ error: 'idempotency_conflict' });
  });

  it('does not equate separate intentions just because names match', async () => {
    const first = await create();
    const second = await create(request({ idempotencyKey: 'another-intention' }));
    expect(second.status).toBe(201);
    expect(second.body.account.id).not.toBe(first.body.account.id);
  });

  it('rolls back the account, key and earlier snapshot on a late failure; the same key can retry', async () => {
    await db
      .prepare(
        "CREATE TRIGGER fail_manual_snapshot BEFORE INSERT ON balance_snapshots WHEN NEW.date = '2026-11-12' BEGIN SELECT RAISE(ABORT, 'injected snapshot failure'); END",
      )
      .run();
    try {
      await expect(
        createManualAccount(db, manualAccountSchema.parse(request()), clock),
      ).rejects.toThrow('injected snapshot failure');
      expect(await selectAll(db, accountsTable)).toEqual([]);
      expect(await selectAll(db, balanceSnapshotsTable)).toEqual([]);
      expect((await db.prepare('SELECT * FROM manual_account_details').all()).results).toEqual([]);
    } finally {
      await db.prepare('DROP TRIGGER fail_manual_snapshot').run();
    }
    expect((await create()).status).toBe(201);
    expect((await create()).status).toBe(200);
  });

  it('keeps creation and account-list query counts bounded', async () => {
    const meter = meterDb(db);
    const { api } = client({ now: clock }, { ...testEnv, DB: meter.db });
    expect((await api('POST', path, request())).status).toBe(201);
    expect(meter.used()).toBeLessThanOrEqual(5);
    const before = meter.used();
    expect((await api('GET', '/v1/accounts')).status).toBe(200);
    expect(meter.used() - before).toBe(1);
  });
});

describe('manual account validation and cash compatibility', () => {
  it.each([
    ['blank name', { name: '   ' }],
    ['long name', { name: 'a'.repeat(101) }],
    ['missing key', { idempotencyKey: undefined }],
    ['blank key', { idempotencyKey: ' ' }],
    ['unknown type', { type: 'bank' }],
    ['cash uses its existing route', { type: 'cash' }],
    ['lowercase currency', { currency: 'inr' }],
    ['missing currency', { currency: undefined }],
    ['blank subtype', { subtype: ' ' }],
    ['missing current choice', { currentBalance: undefined }],
    ['fractional amount', { currentBalance: { amount: 1.1, asOf: now } }],
    ['unsafe amount', { currentBalance: { amount: Number.MAX_SAFE_INTEGER + 1, asOf: now } }],
    ['string amount', { currentBalance: { amount: '100', asOf: now } }],
    ['impossible timestamp', { currentBalance: { amount: 100, asOf: '2026-02-30T12:00:00Z' } }],
    ['timestamp without zone', { currentBalance: { amount: 100, asOf: '2026-11-12T12:00:00' } }],
    ['impossible opening date', { openingBalance: { amount: 100, date: '2025-02-29' } }],
    ['fractional opening amount', { openingBalance: { amount: 1.1, date: '2025-01-01' } }],
    ['opening after current', { openingBalance: { amount: 100, date: '2026-11-13' } }],
    ['unknown in net worth', { currentBalance: null, includeInNetWorth: true }],
    ['provider field', { connectionId: 'conn_invented' }],
    ['nested currency', { currentBalance: { amount: 100, asOf: now, currency: 'USD' } }],
  ])('rejects %s without writing', async (_label, changes) => {
    const result = await create({ ...request(), ...(changes as object) });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: 'invalid_body' });
    expect(await selectAll(db, accountsTable)).toEqual([]);
  });

  it('requires authentication and a JSON body', async () => {
    expect((await client().api('POST', path, request(), null)).status).toBe(401);
    expect((await client().api('POST', path)).status).toBe(400);
    expect(await selectAll(db, accountsTable)).toEqual([]);
  });

  it('preserves cash creation defaults, default-target selection and quick-add balance changes', async () => {
    const { api } = client();
    const cash = await api<{ account: Account }>('POST', '/v1/accounts/cash', {
      name: 'Pocket',
      currency: 'USD',
      balance: 10_000,
      isDefault: true,
    });
    expect(cash.status).toBe(201);
    await create(request({ currency: 'USD', currentBalance: null }));
    expect(
      (await api('POST', '/v1/cash', { currency: 'USD', amount: -250, date: '2026-11-12' })).status,
    ).toBe(201);
    const accounts = (await api<{ accounts: AccountWithManualBalance[] }>('GET', '/v1/accounts'))
      .body.accounts;
    const reloaded = accounts.find((a) => a.id === cash.body.account.id)!;
    expect(reloaded).toMatchObject({
      balance: 9_750,
      isDefaultCash: true,
      includeInNetWorth: true,
    });
    expect(reloaded.manualBalance).toBeUndefined();
    expect(accounts.filter((a) => a.type === 'cash')).toHaveLength(1);
    const zero = await api<{ account: Account }>('POST', '/v1/accounts/cash', {
      name: 'Rupees',
      currency: 'INR',
    });
    expect(zero.body.account).toMatchObject({
      balance: 0,
      isDefaultCash: false,
      includeInNetWorth: true,
    });
  });
});

describe('manual destinations in the import journey', () => {
  it.each([true, false])(
    'imports, repeats and undoes partial CSV history without deriving a balance (known=%s)',
    async (known) => {
      const { api } = client({ now: clock });
      const created = await create(
        request({ currentBalance: known ? { amount: 45_000, asOf: now } : null }),
      );
      const account = created.body.account;
      const csv = 'Date,Description,Amount\n2025-03-10,Paint,-100.00\n2025-08-17,Paper,-50.00\n';
      const preview = () =>
        api<ImportResponse>(
          'POST',
          '/v1/imports',
          upload(
            { accountId: account.id, fromDate: '2025-01-01', toDate: '2025-12-31' },
            csv,
            'invented-history.csv',
          ),
        );
      const first = await preview();
      expect(first.status).toBe(201);
      expect(first.body.preview?.rows.every((r) => r.accountId === account.id)).toBe(true);
      const imported = await api<{ added: number }>(
        'POST',
        `/v1/imports/${first.body.preview!.importId}/commit`,
        {},
      );
      expect(imported.status).toBe(200);
      expect(imported.body.added).toBe(2);
      const second = await preview();
      expect(
        (
          await api<{ added: number }>(
            'POST',
            `/v1/imports/${second.body.preview!.importId}/commit`,
            {},
          )
        ).body.added,
      ).toBe(0);
      expect(await allTxns()).toHaveLength(2);
      const dataset = await api<{
        accounts: AccountWithManualBalance[];
        balanceHistory: BalanceSnapshot[];
      }>('GET', '/v1/dataset');
      expect(dataset.body.accounts).toEqual([account]);
      expect(dataset.body.balanceHistory).toHaveLength(known ? 2 : 1);
      const mismatch = await api(
        'POST',
        '/v1/imports',
        upload(
          { accountId: account.id },
          'Date,Description,Amount,Currency\n2025-03-10,Paint,-100.00,USD\n',
          'invented-usd.csv',
        ),
      );
      expect(mismatch.status).toBe(400);
      expect(mismatch.body).toMatchObject({ error: 'import_currency_mismatch' });
      expect(
        (await api('DELETE', `/v1/imports/${first.body.preview!.importId}/transactions`)).status,
      ).toBe(200);
      expect(await allTxns()).toEqual([]);
      expect(
        (await api<{ accounts: AccountWithManualBalance[] }>('GET', '/v1/accounts')).body.accounts,
      ).toEqual([account]);
    },
  );
});
