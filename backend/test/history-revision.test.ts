import { beforeEach, describe, expect, it } from 'vitest';
import { bulkInsertSpecs, runSpecs } from '../src/db/bulk';
import { transactionsTable } from '../src/db/tables';
import { makeTransaction } from '../src/services/transactions';
import { editTransaction } from '../src/services/edits';
import { splitTransaction, undoSplit } from '../src/services/splits';
import { historyGuards, historySnapshot, readPolicy, writeHistory } from '../src/history/store';
import { previewHistoryPolicy, saveHistoryPolicy } from '../src/history/service';
import { bankReviewList, resolveBankReview } from '../src/history/reviews';
import { previewImport, commitImport, undoImport } from '../src/imports/service';
import { applySyncResult } from '../src/sync/apply';
import { addTxn, allTxns, db, freshDb, testEnv } from './helpers';
import {
  NOW,
  activate,
  bank,
  beforeBatch,
  connection,
  historyFile,
  policy,
  provider,
  result,
} from './history-fixtures';
import { measureRows } from './d1-work';

beforeEach(freshDb);
const request = (p: Awaited<ReturnType<typeof previewHistoryPolicy>>) => ({
  policy: p.policy,
  expectedVersion: p.expectedVersion,
  previewToken: p.previewToken,
});
async function fence(database = db, revision?: string) {
  const version = (await readPolicy(database)).version;
  await writeHistory(
    database,
    historyGuards(version, revision ?? (await historySnapshot(database))),
  );
}

describe('fixed-size history concurrency fence', () => {
  it('activates and continues import, sync, boundary review, retry and undo above the old 1 MB limit', async () => {
    const c = await connection(),
      a = await bank();
    const rows = Array.from({ length: 6000 }, (_, i) =>
      makeTransaction({
        id: `large_${i}`,
        accountId: a.id,
        connectionId: c.id,
        date: new Date(Date.UTC(2020, 0, 1 + Math.floor(i / 3))).toISOString().slice(0, 10),
        amount: -10000 - i,
        currency: 'USD',
        source: 'connector',
        externalId: `large-provider-${i}`,
        name: 'Invented purchase '.repeat(10),
        rawName: 'Invented provider description '.repeat(6),
      }),
    );
    const small = measureRows(db);
    await fence(small.db);
    await runSpecs(db, bulkInsertSpecs(transactionsTable, rows));
    const bytes = await db
      .prepare(
        `SELECT sum(length(CAST(json_array(id, account_id, date, amount,
      currency, source, external_id, name, raw_name) AS BLOB))) AS n FROM transactions`,
      )
      .first<number>('n');
    expect(bytes).toBeGreaterThan(1_000_000);
    const large = measureRows(db);
    await fence(large.db);
    expect(large.read()).toBe(small.read());
    expect(large.written()).toBe(small.written());
    expect(large.read()).toBeLessThan(10);
    expect(await historySnapshot(db)).toMatch(/^[a-f0-9]{64}$/);
    const p = await previewHistoryPolicy(db, { defaultCutoff: '2020-01-01', accounts: [] });
    expect(p.allowed).toBe(true);
    const saved = await saveHistoryPolicy(db, request(p), NOW);
    expect(saved.version).toBe(1);
    expect(await saveHistoryPolicy(db, request(p), NOW)).toMatchObject({
      replayed: true,
      version: 1,
    });
    const input = {
      ...historyFile(['12-31-19,Orchard,Books,-5.01,USD,-5.01,USD,Boundary']),
      accountMappings: { Orchard: a.id },
      preferDayFirst: false,
    };
    const imported = await previewImport(testEnv, input);
    expect((await commitImport(testEnv, imported.importId)).added).toBe(1);
    await expect(commitImport(testEnv, imported.importId)).rejects.toMatchObject({
      code: 'conflict',
    });
    const incoming = result(
      [a],
      [provider(a, '2020-01-01', -501, 'boundary'), provider(a, '2026-01-01', -599, 'new')],
    );
    expect(await applySyncResult(db, c, incoming, NOW)).toMatchObject({
      inserted: 1,
      historyPolicy: { pendingReview: 1 },
    });
    expect((await applySyncResult(db, c, incoming, NOW)).inserted).toBe(0);
    const review = (await bankReviewList(db)).reviews[0]!;
    const decision = { previewToken: review.previewToken, decision: 'keep' as const };
    expect(await resolveBankReview(db, review.id, decision, NOW)).toMatchObject({
      replayed: false,
    });
    expect(await resolveBankReview(db, review.id, decision, NOW)).toMatchObject({ replayed: true });
    expect((await previewHistoryPolicy(db, p.policy)).allowed).toBe(true);
    expect(await undoImport(db, imported.importId)).toBe(1);
    expect(await undoImport(db, imported.importId)).toBe(0);
    expect(await allTxns()).toHaveLength(6002);
    expect(
      await db.prepare('SELECT balance FROM accounts WHERE id = ?').bind(a.id).first('balance'),
    ).toBe(98765);
  });

  it('rejects a stale preview after an edit and its reversal with an unchanged timestamp (no ABA)', async () => {
    const a = await bank(),
      t = await addTxn(a, { source: 'manual', date: '2024-03-01', amount: -500 });
    const p = await previewHistoryPolicy(db, policy);
    await db
      .prepare('UPDATE transactions SET notes = ? WHERE id = ?')
      .bind('Changed without a clock tick', t.id)
      .run();
    await db.prepare('UPDATE transactions SET notes = ? WHERE id = ?').bind(t.notes, t.id).run();
    expect((await allTxns())[0]).toEqual(t);
    await expect(saveHistoryPolicy(db, request(p), NOW)).rejects.toMatchObject({
      code: 'history_policy_changed',
    });
    expect((await readPolicy(db)).version).toBe(0);
  });

  it('rolls back revision changes and financial effects together, then permits retry', async () => {
    const a = await bank(),
      t = await addTxn(a, { date: '2024-03-01', amount: -500 });
    const revision = await historySnapshot(db);
    const [guard, release] = historyGuards(0, revision);
    const edit = {
      sql: 'UPDATE transactions SET notes = ? WHERE id = ?',
      params: ['Saved once', t.id],
      rows: 1,
    };
    await expect(
      writeHistory(db, [
        guard,
        edit,
        { sql: 'INSERT INTO history_write_guard VALUES (?, 0)', params: ['fail'], rows: 1 },
        release,
      ]),
    ).rejects.toMatchObject({ code: 'history_policy_changed' });
    expect(await historySnapshot(db)).toBe(revision);
    expect((await allTxns())[0]).toEqual(t);
    await writeHistory(db, [guard, edit, release]);
    expect(await historySnapshot(db)).not.toBe(revision);
    expect(await db.prepare('SELECT count(*) AS n FROM history_write_guard').first('n')).toBe(0);
  });

  it('fences simultaneous decisions while balance-only updates leave a reviewed preview valid', async () => {
    const a = await bank();
    const p = await previewHistoryPolicy(db, policy),
      revision = await historySnapshot(db);
    await db
      .prepare(
        'UPDATE accounts SET balance = 12345, available_balance = 10000, balance_as_of = ?, updated_at = ? WHERE id = ?',
      )
      .bind(NOW, NOW, a.id)
      .run();
    expect(await historySnapshot(db)).toBe(revision);
    const outcomes = await Promise.allSettled([
      saveHistoryPolicy(db, request(p), NOW),
      saveHistoryPolicy(db, request(p), NOW),
    ]);
    expect(outcomes.some((o) => o.status === 'fulfilled')).toBe(true);
    expect((await readPolicy(db)).version).toBe(1);
    expect(await saveHistoryPolicy(db, request(p), NOW)).toMatchObject({ replayed: true });
  });

  it('covers edit, split and undo writers, and does not advance on a split replay', async () => {
    const a = await bank(),
      t = await addTxn(a, { date: '2024-03-01', amount: -500 });
    let revision = await historySnapshot(db);
    await editTransaction(db, t.id, { notes: 'User note', reviewed: true });
    expect(await historySnapshot(db)).not.toBe(revision);
    revision = await historySnapshot(db);
    const input = {
      parentTransactionId: t.id,
      idempotencyKey: 'revision-split',
      lines: [
        { amount: -200, categoryId: null },
        { amount: -300, categoryId: null },
      ],
    };
    await splitTransaction(db, input);
    expect(await historySnapshot(db)).not.toBe(revision);
    revision = await historySnapshot(db);
    expect(await splitTransaction(db, input)).toMatchObject({ replayed: true });
    expect(await historySnapshot(db)).toBe(revision);
    await undoSplit(db, t.id);
    expect(await historySnapshot(db)).not.toBe(revision);
  });

  it('fences changes to committed import review decisions even without a transaction edit', async () => {
    const a = await bank();
    const p = await previewImport(testEnv, {
      ...historyFile(['03-01-24,Orchard,Books,-5,USD,-5,USD,Purchase']),
      accountMappings: { Orchard: a.id },
      preferDayFirst: false,
    });
    await commitImport(testEnv, p.importId);
    const revision = await historySnapshot(db);
    await db
      .prepare(
        'UPDATE imports SET preview = json_set(preview, \'$.reviewedBoundaryPairs\', json(\'[{"monefyTransactionId":"example","bankTransactionIds":["other"]}]\')) WHERE id = ?',
      )
      .bind(p.importId)
      .run();
    await expect(fence(db, revision)).rejects.toMatchObject({ code: 'history_policy_changed' });
  });

  it('rejects import and review write races, preserving balances and retryability', async () => {
    const c = await connection(),
      a = await bank();
    await activate();
    const p = await previewImport(testEnv, {
      ...historyFile(['04-14-24,Orchard,Books,-5,USD,-5,USD,Purchase']),
      accountMappings: { Orchard: a.id },
      preferDayFirst: false,
    });
    const raced = beforeBatch(() =>
      db.prepare('UPDATE accounts SET type = ? WHERE id = ?').bind('savings', a.id).run(),
    );
    await expect(commitImport({ ...testEnv, DB: raced }, p.importId)).rejects.toMatchObject({
      code: 'history_policy_changed',
    });
    expect(await allTxns()).toHaveLength(0);
    expect((await commitImport(testEnv, p.importId)).added).toBe(1);
    await applySyncResult(db, c, result([a], [provider(a, '2024-04-15')]), NOW);
    const review = (await bankReviewList(db)).reviews[0]!;
    await expect(
      resolveBankReview(
        beforeBatch(() => undoImport(db, p.importId)),
        review.id,
        { previewToken: review.previewToken, decision: 'keep' },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'history_policy_changed' });
    expect((await bankReviewList(db)).reviews[0]?.status).toBe('pending');
    const next = (await bankReviewList(db)).reviews[0]!;
    expect(next.candidates).toEqual([]);
    expect(
      await resolveBankReview(
        db,
        next.id,
        { previewToken: next.previewToken, decision: 'keep' },
        NOW,
      ),
    ).toMatchObject({ replayed: false });
  });

  it('re-reads account identity under the fence after independent sync balance writes', async () => {
    const c = await connection(),
      a = await bank();
    await activate();
    // Simulate an identity change after the balance batch but before revision read.
    const changed = new Proxy(db, {
      get(target, key) {
        if (key === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            const res = await target.batch(statements);
            await target
              .prepare("UPDATE accounts SET connection_id = 'another-connection' WHERE id = ?")
              .bind(a.id)
              .run();
            return res;
          };
        const value: unknown = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(
      applySyncResult(changed, c, result([a], [provider(a, '2024-04-15')]), NOW),
    ).rejects.toMatchObject({ code: 'history_policy_changed' });
    expect(await allTxns()).toEqual([]);
    expect(
      await db.prepare('SELECT balance FROM accounts WHERE id = ?').bind(a.id).first('balance'),
    ).toBe(98765);
  });

  it('tracks raw and bulk upserts/deletes, while ignored inserts and unmatched updates do not invalidate review', async () => {
    const a = await bank();
    const t = makeTransaction({
      id: 'raw-writer',
      source: 'manual',
      accountId: a.id,
      date: '2024-03-01',
      amount: -500,
      currency: 'USD',
    });
    let revision = await historySnapshot(db);
    await runSpecs(db, bulkInsertSpecs(transactionsTable, [t]));
    await expect(fence(db, revision)).rejects.toMatchObject({ code: 'history_policy_changed' });
    revision = await historySnapshot(db);
    await runSpecs(db, bulkInsertSpecs(transactionsTable, [t], 'ignore'));
    await db.prepare("UPDATE transactions SET notes = 'Absent' WHERE id = 'missing'").run();
    expect(await historySnapshot(db)).toBe(revision);
    await runSpecs(
      db,
      bulkInsertSpecs(transactionsTable, [{ ...t, notes: 'Changed by bulk writer' }], 'upsert'),
    );
    await expect(fence(db, revision)).rejects.toMatchObject({ code: 'history_policy_changed' });
    revision = await historySnapshot(db);
    await db.prepare('DELETE FROM transactions WHERE id = ?').bind(t.id).run();
    await expect(fence(db, revision)).rejects.toMatchObject({ code: 'history_policy_changed' });
    expect(await allTxns()).toEqual([]);
  });

  it('retains a committed decision after a lost response, and exact retry performs no write', async () => {
    const c = await connection(),
      a = await bank();
    await activate();
    await addTxn(a, {
      date: '2024-04-14',
      amount: -500,
      source: 'import',
      externalId: 'monefy:lost-answer',
    });
    await applySyncResult(db, c, result([a], [provider(a, '2024-04-15')]), NOW);
    const review = (await bankReviewList(db)).reviews[0]!;
    const input = { previewToken: review.previewToken, decision: 'keep' as const };
    const lost = new Proxy(db, {
      get(target, key) {
        if (key === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            await target.batch(statements);
            throw new Error('Invented lost batch response');
          };
        const value: unknown = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(resolveBankReview(lost, review.id, input, NOW)).rejects.toThrow(
      'lost batch response',
    );
    const revision = await historySnapshot(db);
    expect(await resolveBankReview(db, review.id, input, NOW)).toMatchObject({ replayed: true });
    expect(await historySnapshot(db)).toBe(revision);
    expect(await allTxns()).toHaveLength(2);
    expect((await bankReviewList(db, review.id)).reviews[0]?.status).toBe('kept');
  });

  it('fails closed when the revision row is missing', async () => {
    await db.prepare('DELETE FROM history_revision').run();
    try {
      await expect(historySnapshot(db)).rejects.toMatchObject({ code: 'history_policy_changed' });
      await expect(fence(db, 'a'.repeat(64))).rejects.toMatchObject({
        code: 'history_policy_changed',
      });
    } finally {
      await db.prepare('INSERT INTO history_revision VALUES (1, lower(hex(randomblob(32))))').run();
    }
  });
});
