import { beforeEach, describe, expect, it } from 'vitest';
import { selectAll } from '../src/db/table';
import { accountsTable, categoriesTable } from '../src/db/tables';
import { D1_QUERIES_PER_INVOCATION, meterDb } from '../src/db/meter';
import {
  commitImport,
  discardImport,
  getImport,
  previewImport,
  undoImport,
} from '../src/imports/service';
import { type SafeImportPreview } from '../src/imports/safety';
import { addAccount, addTxn, allTxns, db, file, freshDb, testEnv } from './helpers';
import { client, upload } from './worker';
import { fakeAi } from './fakes';
import ofx from './fixtures/imports/checking.ofx?raw';
import qif from './fixtures/imports/card-with-splits.qif?raw';
import statement from './fixtures/ai/statement-nre.json';

beforeEach(freshDb);

// Entirely invented rows. No uploaded data is copied into this fixture.
const header = 'date,account,category,amount,currency,converted amount,currency,description';
const monefy =
  '\uFEFF' +
  [
    header,
    '10-23-25,Pocket,Hobbies,-14.25,USD,-14.25,USD,"Paint, paper"',
    '10-23-25,Pocket,Hobbies,-14.25,USD,-14.25,USD,"Paint, paper"',
    '10-24-25,Travel,Books,-270,INR,-3.25,USD,"पुस्तक\nSecond line"',
    '10-25-25,Pocket,Freelance,125.5,USD,125.5,USD,Project fee',
  ].join('\n');
const csv = 'Date,Description,Amount\n2025-10-23,Tea,-4.50\n';
const clock = () => new Date('2026-11-06T12:00:00.000Z');

describe('destination and currency safeguards', () => {
  it('uses the selected account even when OFX matches another mask', async () => {
    await addAccount({ type: 'checking', mask: '4821' });
    const chosen = await addAccount({ type: 'checking', mask: '1234' });
    const p = await previewImport(testEnv, { ...file(ofx, 'bank.ofx'), accountId: chosen.id });
    expect(p.rows.every((r) => r.accountId === chosen.id)).toBe(true);
    expect(p.accountsToCreate).toEqual([]);
    await commitImport(testEnv, p.importId);
    expect((await allTxns()).every((t) => t.accountId === chosen.id)).toBe(true);
  });

  it.each(['csv', 'ofx', 'pdf'])(
    'rejects %s currency mismatch without saving transactions',
    async (format) => {
      const account = await addAccount({
        type: 'savings',
        currency: format === 'ofx' ? 'INR' : 'USD',
      });
      const text =
        format === 'csv'
          ? 'Date,Description,Amount,Currency\n2025-10-23,Tea,-100,INR'
          : format === 'ofx'
            ? ofx
            : '%PDF invented';
      await expect(
        previewImport(
          testEnv,
          {
            ...file(text, `test.${format}`),
            accountId: account.id,
          },
          fakeAi({ statement }).deps,
        ),
      ).rejects.toMatchObject({ code: 'import_currency_mismatch' });
      expect(await allTxns()).toEqual([]);
    },
  );

  it.each(['nre', 'nro'])('imports a QIF into the selected INR %s account', async (subtype) => {
    const account = await addAccount({ type: 'savings', subtype, currency: 'INR' });
    const p = await previewImport(testEnv, {
      ...file('!Type:Bank\nD23/10/2025\nT-150.00\nPBooks\n^', 'bank.qif'),
      accountId: account.id,
    });
    await commitImport(testEnv, p.importId);
    expect(await allTxns()).toEqual([
      expect.objectContaining({
        accountId: account.id,
        amount: -15000,
        currency: 'INR',
        date: '2025-10-23',
      }),
    ]);
  });

  it('blocks an unresolved CSV instead of reporting a zero-row success', async () => {
    const p = await previewImport(testEnv, file(csv, 'bank.csv'));
    await expect(commitImport(testEnv, p.importId)).rejects.toMatchObject({
      code: 'import_account_required',
    });
    expect((await getImport(db, p.importId)).status).toBe('preview');
    expect(await allTxns()).toEqual([]);
  });

  it('rechecks a destination currency changed after preview', async () => {
    const account = await addAccount({ type: 'checking', currency: 'USD' });
    const p = await previewImport(testEnv, {
      ...file(csv, 'bank.csv'),
      accountId: account.id,
    });
    await db.prepare('UPDATE accounts SET currency = ? WHERE id = ?').bind('INR', account.id).run();
    await expect(commitImport(testEnv, p.importId)).rejects.toMatchObject({
      code: 'import_currency_mismatch',
    });
    expect(await allTxns()).toEqual([]);
  });

  it('requires explicit mapping for ambiguous names and multi-account selections', async () => {
    const a = await addAccount({ type: 'checking', name: 'Pocket' });
    await addAccount({ type: 'cash', name: 'Pocket' });
    await expect(
      previewImport(testEnv, { ...file(monefy, 'history.csv'), accountId: a.id }),
    ).rejects.toThrow('multiple accounts');
    await expect(previewImport(testEnv, file(monefy, 'history.csv'))).rejects.toThrow(
      'More than one account',
    );
    const travel = await addAccount({ type: 'cash', currency: 'INR' });
    const p = await previewImport(testEnv, {
      ...file(monefy, 'history.csv'),
      accountMappings: { Pocket: a.id, Travel: travel.id },
    });
    expect(p.accountsToCreate).toEqual([]);
    expect(new Set(p.rows.map((r) => r.accountId))).toEqual(new Set([a.id, travel.id]));
  });
});

describe('Monefy history', () => {
  it('preserves both identical expenses, Unicode, notes, categories, income and original currencies', async () => {
    const p = await previewImport(testEnv, file(monefy, 'history.csv'));
    expect(p.sourceFormat).toBe('monefy');
    expect(p.errors).toEqual([]);
    expect(p.rows.map((r) => [r.date, r.amount, r.currency])).toEqual([
      ['2025-10-23', -1425, 'USD'],
      ['2025-10-23', -1425, 'USD'],
      ['2025-10-24', -27000, 'INR'],
      ['2025-10-25', 12550, 'USD'],
    ]);
    expect(new Set(p.rows.map((r) => r.externalId)).size).toBe(4);
    expect((await commitImport(testEnv, p.importId)).added).toBe(4);
    const txns = await allTxns();
    expect(txns.find((t) => t.amount === -27000)).toMatchObject({
      rawName: 'पुस्तक\nSecond line',
      currency: 'INR',
      originalCurrency: 'INR',
      notes: 'पुस्तक\nSecond line\n\nMonefy category: Books\nMonefy converted amount: -3.25 USD',
    });
    const categories = await selectAll(db, categoriesTable);
    expect(categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Hobbies', kind: 'expense' }),
        expect.objectContaining({ name: 'Freelance', kind: 'income' }),
      ]),
    );
    expect(
      txns.every((t) => t.categoryId !== null && t.userEditedFields.includes('categoryId')),
    ).toBe(true);
    expect(
      (await selectAll(db, accountsTable)).every(
        (a) => a.type === 'other_asset' && !a.includeInNetWorth,
      ),
    ).toBe(true);
    const repeat = await previewImport(
      testEnv,
      file(monefy.replace('-3.25', '-3.50'), 'renamed.csv'),
    );
    expect((await commitImport(testEnv, repeat.importId)).added).toBe(0);
    expect(await allTxns()).toHaveLength(4);
  });

  it('supports inclusive periods and later wider imports without collapsing identical rows', async () => {
    const { api } = client();
    const first = await api<{ preview: SafeImportPreview }>(
      'POST',
      '/v1/imports',
      upload({ fromDate: '2025-10-23', toDate: '2025-10-23' }, monefy, 'history.csv'),
    );
    expect(first.status).toBe(201);
    expect(first.body.preview.dateRange).toEqual({
      from: '2025-10-23',
      to: '2025-10-23',
      excluded: 2,
    });
    expect((await commitImport(testEnv, first.body.preview.importId)).added).toBe(2);
    const wider = await previewImport(testEnv, file(monefy, 'history.csv'));
    expect((await commitImport(testEnv, wider.importId)).added).toBe(2);
    expect(await allTxns()).toHaveLength(4);
  });

  it('requires confirmation for ambiguous two-digit dates', async () => {
    const text = `${header}\n03-04-25,Wallet,Snacks,-2,USD,-2,USD,Crackers`;
    const p = await previewImport(testEnv, file(text, 'history.csv'));
    await expect(commitImport(testEnv, p.importId)).rejects.toThrow('Confirm Monefy date order');
    const confirmed = await previewImport(testEnv, {
      ...file(text, 'history.csv'),
      preferDayFirst: true,
    });
    expect(confirmed.rows[0]?.date).toBe('2025-04-03');
    expect((await commitImport(testEnv, confirmed.importId)).added).toBe(1);
  });

  it.each([
    '10-23-25,Wallet,Snacks,nope,USD,-2,USD,Crackers',
    '02-30-25,Wallet,Snacks,-2,USD,-2,USD,Crackers',
    '10-23-25,Wallet,Transfer,-2,USD,-2,USD,Move',
  ])('does not silently omit unreadable or unsupported rows', async (row) => {
    const text = `${header}\n10-24-25,Wallet,Snacks,-3,USD,-3,USD,Juice\n${row}`;
    const p = await previewImport(testEnv, file(text, 'history.csv'));
    expect(p.errors).toHaveLength(1);
    await expect(commitImport(testEnv, p.importId)).rejects.toMatchObject({
      code: 'import_parse_errors',
    });
    expect(await allTxns()).toEqual([]);
    expect((await commitImport(testEnv, p.importId, { skipLines: [3] })).added).toBe(1);
  });

  it('rejects currency-less QIF creation instead of assuming USD', async () => {
    await expect(
      previewImport(testEnv, file('!Type:Bank\nD10/23/2025\nT-2\nPTea\n^', 'bank.qif')),
    ).rejects.toThrow('QIF does not specify currency');
  });
});

describe('date bounds and duplicate review', () => {
  it.each<Record<string, string>>([
    { fromDate: '2025-02-30' },
    { toDate: 'yesterday' },
    { fromDate: '2025-10-24', toDate: '2025-10-23' },
  ])('rejects invalid or reversed date bounds', async (fields) => {
    const result = await client().api('POST', '/v1/imports', upload(fields, csv, 'bank.csv'));
    expect(result.status).toBe(400);
  });

  it('requires keep/skip even for identical descriptions and never merges different accounts', async () => {
    const account = await addAccount({ type: 'checking' });
    const another = await addAccount({ type: 'checking' });
    const existing = await addTxn(account, {
      date: '2025-10-22',
      amount: -450,
      rawName: 'Tea',
      source: 'connector',
    });
    await addTxn(another, { date: '2025-10-23', amount: -450, rawName: 'Tea' });
    const p = await previewImport(testEnv, {
      ...file(csv + '2025-10-23,Coffee,-4.50\n', 'bank.csv'),
      accountId: account.id,
    });
    expect(p.counts).toMatchObject({ new: 2, existing: 0 });
    expect(p.duplicateCandidates).toEqual([
      { line: 2, transactionIds: [existing.id] },
      { line: 3, transactionIds: [existing.id] },
    ]);
    await expect(commitImport(testEnv, p.importId)).rejects.toMatchObject({
      code: 'import_duplicates_require_review',
    });
    const result = await client().api<{ added: number; skipped: number }>(
      'POST',
      `/v1/imports/${p.importId}/commit`,
      { keepLines: [2], skipLines: [3] },
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ added: 1, skipped: 1 });
    expect(await allTxns()).toHaveLength(3);
  });

  it('rechecks possible duplicates that arrived after preview', async () => {
    const account = await addAccount({ type: 'checking' });
    const p = await previewImport(testEnv, { ...file(csv, 'bank.csv'), accountId: account.id });
    await addTxn(account, { date: '2025-10-23', amount: -450, source: 'connector' });
    await expect(commitImport(testEnv, p.importId)).rejects.toMatchObject({
      code: 'import_duplicates_require_review',
    });
    expect(await allTxns()).toHaveLength(1);
  });
});

describe('atomic import saves and recovery', () => {
  it('aborts atomically if a sync adds a candidate between validation and the write batch', async () => {
    const account = await addAccount({ type: 'checking' });
    const p = await previewImport(testEnv, { ...file(csv, 'bank.csv'), accountId: account.id });
    let injected = false;
    const raced = new Proxy(db, {
      get(target, key) {
        if (key === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            if (!injected) {
              injected = true;
              await addTxn(account, { date: '2025-10-23', amount: -450, source: 'connector' });
            }
            return target.batch(statements);
          };
        const value: unknown = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(commitImport({ ...testEnv, DB: raced }, p.importId)).rejects.toMatchObject({
      code: 'import_preview_changed',
    });
    expect(await allTxns()).toEqual([expect.objectContaining({ source: 'connector' })]);
    expect((await getImport(db, p.importId)).status).toBe('preview');
  });

  it('saves a multi-chunk import within the Workers Free query limit', async () => {
    const account = await addAccount({ type: 'checking' });
    const text =
      'Date,Description,Amount\n' +
      Array.from({ length: 1200 }, (_, i) => `2025-10-23,Purchase ${i},-1.00`).join('\n');
    const previewMeter = meterDb(db);
    const p = await previewImport(
      { ...testEnv, DB: previewMeter.db },
      { ...file(text, 'history.csv'), accountId: account.id },
    );
    const commitMeter = meterDb(db);
    expect((await commitImport({ ...testEnv, DB: commitMeter.db }, p.importId)).added).toBe(1200);
    expect(previewMeter.used()).toBeLessThanOrEqual(D1_QUERIES_PER_INVOCATION);
    expect(commitMeter.used()).toBeLessThanOrEqual(D1_QUERIES_PER_INVOCATION);
  });

  it('reports a saved import with a warning if transfer matching fails afterwards', async () => {
    const checking = await addAccount({ type: 'checking' });
    const card = await addAccount({ type: 'credit_card' });
    await addTxn(checking, { date: '2026-11-04', amount: -20000, rawName: 'CARD AUTOPAY' });
    const p = await previewImport(testEnv, { ...file(qif, 'card.qif'), accountId: card.id });
    await db
      .prepare(
        "CREATE TRIGGER fail_link BEFORE INSERT ON transfer_links BEGIN SELECT RAISE(ABORT, 'injected link failure'); END",
      )
      .run();
    try {
      const saved = await commitImport(testEnv, p.importId);
      expect(saved.added).toBe(3);
      expect(saved.warnings).toHaveLength(1);
      const record = await getImport(db, p.importId);
      expect(record.status).toBe('committed');
      expect(record.error).toContain('Transactions saved');
    } finally {
      await db.prepare('DROP TRIGGER fail_link').run();
    }
  });

  it('rolls back accounts, custom categories and transactions when completion fails, then retries once', async () => {
    const p = await previewImport(testEnv, file(monefy, 'history.csv'));
    const before = await selectAll(db, categoriesTable);
    await db
      .prepare(
        "CREATE TRIGGER fail_import_completion BEFORE UPDATE OF status ON imports WHEN NEW.status = 'committed' BEGIN SELECT RAISE(ABORT, 'injected import failure'); END",
      )
      .run();
    try {
      await expect(commitImport(testEnv, p.importId)).rejects.toThrow('injected import failure');
      expect(await selectAll(db, accountsTable)).toEqual([]);
      expect(await selectAll(db, categoriesTable)).toEqual(before);
      expect(await allTxns()).toEqual([]);
      expect((await getImport(db, p.importId)).status).toBe('preview');
    } finally {
      await db.prepare('DROP TRIGGER fail_import_completion').run();
    }
    expect((await commitImport(testEnv, p.importId)).added).toBe(4);
    expect(await allTxns()).toHaveLength(4);
  });

  it('never leaves a QIF split parent without its children after a failed save', async () => {
    const account = await addAccount({ type: 'credit_card' });
    const p = await previewImport(testEnv, { ...file(qif, 'card.qif'), accountId: account.id });
    await db
      .prepare(
        "CREATE TRIGGER fail_split BEFORE INSERT ON transactions WHEN NEW.split_parent_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'injected split failure'); END",
      )
      .run();
    try {
      await expect(commitImport(testEnv, p.importId)).rejects.toThrow('injected split failure');
      expect(await allTxns()).toEqual([]);
    } finally {
      await db.prepare('DROP TRIGGER fail_split').run();
    }
    expect((await commitImport(testEnv, p.importId)).added).toBe(3);
    expect((await allTxns()).filter((t) => t.splitParentId !== null)).toHaveLength(2);
  });

  it('two stale previews reuse newly created accounts and add history once', async () => {
    const a = await previewImport(testEnv, file(monefy, 'history.csv'));
    const b = await previewImport(testEnv, file(monefy, 'history.csv'));
    expect((await commitImport(testEnv, a.importId)).added).toBe(4);
    const second = await commitImport(testEnv, b.importId);
    expect(second).toMatchObject({ added: 0, matched: 4, accountsCreated: [] });
    expect(await selectAll(db, accountsTable)).toHaveLength(2);
  });

  it('recovers an interrupted commit after five minutes, with an injected clock', async () => {
    const p = await previewImport(testEnv, file(monefy, 'history.csv'));
    await db
      .prepare("UPDATE imports SET status = 'committing', updated_at = ? WHERE id = ?")
      .bind('2026-11-06T11:58:00.000Z', p.importId)
      .run();
    await expect(commitImport(testEnv, p.importId, {}, clock)).rejects.toMatchObject({
      status: 409,
    });
    await expect(discardImport(db, p.importId)).rejects.toMatchObject({ status: 409 });
    await expect(undoImport(db, p.importId)).rejects.toMatchObject({ status: 409 });
    await db
      .prepare('UPDATE imports SET updated_at = ? WHERE id = ?')
      .bind('2026-11-06T11:54:00.000Z', p.importId)
      .run();
    expect((await commitImport(testEnv, p.importId, {}, clock)).added).toBe(4);
    expect((await getImport(db, p.importId)).committedAt).toBe(clock().toISOString());
  });
});
