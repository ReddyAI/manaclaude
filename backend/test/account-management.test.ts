import { beforeEach, describe, expect, it } from 'vitest';
import type { Account, Transaction } from '@manaclaude/shared';
import type { AccountWithManualBalance } from '../src/services/accounts';
import type { deletionPreview } from '../src/services/account-deletion';
import { accountDetail } from '../src/services/account-editing';
import { addAccount, addTxn, allTxns, db, freshDb, testEnv } from './helpers';
import { client, upload } from './worker';
import { meterDb } from '../src/db/meter';

beforeEach(freshDb);
const now = '2026-11-13T12:00:00.000Z';
const { api } = client({ now: () => new Date(now) });
type Detail = Awaited<ReturnType<typeof accountDetail>>;
type Preview = Awaited<ReturnType<typeof deletionPreview>>['preview'];
const detail = (id: string) => api<Detail>('GET', `/v1/accounts/${id}`);
const patch = async (id: string, changes: object) =>
  api<Detail>('PATCH', `/v1/accounts/${id}`, {
    expectedVersion: (await detail(id)).body.version,
    ...changes,
  });
const preview = (id: string) => api<Preview>('GET', `/v1/accounts/${id}/deletion-preview`);
const remove = async (id: string) =>
  api('DELETE', `/v1/accounts/${id}`, {
    previewToken: (await preview(id)).body.previewToken,
  });
const manualRequest = {
  idempotencyKey: 'invented-key',
  name: 'Orchard',
  type: 'savings',
  currency: 'USD',
  openingBalance: { amount: 300, date: '2025-01-01' },
  currentBalance: null,
};
async function manual() {
  return (
    await api<{ account: AccountWithManualBalance }>('POST', '/v1/accounts/manual', manualRequest)
  ).body.account;
}
async function cash() {
  return (
    await api<{ account: Account }>('POST', '/v1/accounts/cash', {
      name: 'Pocket',
      currency: 'USD',
      balance: 10000,
      isDefault: true,
    })
  ).body.account;
}
async function entry(account: Account, amount = -500) {
  const result = await api<{ transaction: Transaction }>('POST', '/v1/cash', {
    accountId: account.id,
    amount,
    currency: account.currency,
    date: '2026-11-13',
    name: 'Invented lunch',
  });
  expect(result.status).toBe(201);
  return result.body.transaction;
}

describe('unconnected account editing', () => {
  it('sets unknown to known zero, renames and changes kind; list and dataset include provenance', async () => {
    const a = await manual();
    const saved = await patch(a.id, {
      name: ' New name ',
      type: 'checking',
      currentBalance: { amount: 0, asOf: '2026-11-01T12:00:00Z' },
      includeInNetWorth: true,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.account).toMatchObject({
      name: 'New name',
      type: 'checking',
      balance: 0,
      balanceAsOf: '2026-11-01T12:00:00.000Z',
      includeInNetWorth: true,
      manualBalance: { currentKnown: true, openingBalance: { amount: 300, date: '2025-01-01' } },
    });
    for (const url of ['/v1/accounts', '/v1/dataset'])
      expect(
        (await api<{ accounts: AccountWithManualBalance[] }>('GET', url)).body.accounts,
      ).toEqual([saved.body.account]);
    expect(await allTxns()).toEqual([]);
    expect((await db.prepare('SELECT * FROM balance_snapshots').all()).results).toHaveLength(2);
    expect((await patch(a.id, { currentBalance: null })).body.account).toMatchObject({
      balance: 0,
      includeInNetWorth: false,
      manualBalance: { currentKnown: false },
    });
    expect((await db.prepare('SELECT * FROM balance_snapshots').all()).results).toHaveLength(2);
    expect((await patch(a.id, { includeInNetWorth: true })).status).toBe(400);
  });
  it('adds provenance to legacy accounts only when explicitly choosing a balance', async () => {
    const a = await addAccount({ type: 'other_asset', includeInNetWorth: false });
    expect((await patch(a.id, { name: 'Renamed' })).body.account.manualBalance).toBeUndefined();
    const saved = await patch(a.id, {
      currentBalance: { amount: -4500, asOf: now },
      includeInNetWorth: true,
    });
    expect(saved.body.account.manualBalance).toEqual({ currentKnown: true, openingBalance: null });
    expect((await patch(a.id, { includeInNetWorth: false })).body.account.balance).toBe(-4500);
  });
  it('uses optimistic versions; a lost answer retry cannot undo a later edit', async () => {
    const a = await manual();
    const body = { expectedVersion: (await detail(a.id)).body.version, name: 'First' };
    expect((await api('PATCH', `/v1/accounts/${a.id}`, body)).status).toBe(200);
    expect((await patch(a.id, { name: 'Second' })).status).toBe(200);
    expect((await api('PATCH', `/v1/accounts/${a.id}`, body)).body).toMatchObject({
      error: 'account_changed',
    });
    expect((await detail(a.id)).body.account.name).toBe('Second');
  });
  it.each([
    { name: ' ' },
    { type: 'bank' },
    { currency: 'INR' },
    { subtype: 'nro' },
    { currentBalance: { amount: 1.5, asOf: now } },
    { currentBalance: { amount: Number.MAX_SAFE_INTEGER + 1, asOf: now } },
    { currentBalance: { amount: 200, asOf: '2026-02-30T12:00:00Z' } },
    { currentBalance: { amount: 200, asOf: '2026-11-13T12:00:00+01:00' } },
    { currentBalance: { amount: 200, asOf: '2024-11-13T12:00:00Z' } },
    { currentBalance: null, includeInNetWorth: true },
    { openingBalance: null },
    {},
  ])('rejects invalid patch %j', async (changes) => {
    const a = await manual();
    expect((await patch(a.id, changes)).status).toBe(400);
    expect((await detail(a.id)).body.account).toEqual(a);
  });
  it('refuses provider accounts and conversions across the cash boundary', async () => {
    for (const fields of [{ connectionId: 'invented' }, { externalId: 'invented' }]) {
      const a = await addAccount({ type: 'checking', ...fields });
      expect((await patch(a.id, { name: 'No' })).body).toMatchObject({
        error: 'account_connected',
      });
    }
    expect((await patch((await manual()).id, { type: 'cash' })).body).toMatchObject({
      error: 'account_kind_conflict',
    });
    expect((await patch((await cash()).id, { type: 'checking' })).body).toMatchObject({
      error: 'account_kind_conflict',
    });
  });
  it('rolls back a failed snapshot and permits retry', async () => {
    const a = await manual();
    const before = (await detail(a.id)).body;
    await db
      .prepare(
        "CREATE TRIGGER fail_account_snapshot BEFORE INSERT ON balance_snapshots BEGIN SELECT RAISE(ABORT, 'injected'); END",
      )
      .run();
    try {
      expect((await patch(a.id, { currentBalance: { amount: 150, asOf: now } })).status).toBe(500);
    } finally {
      await db.prepare('DROP TRIGGER fail_account_snapshot').run();
    }
    expect((await detail(a.id)).body).toEqual(before);
    expect((await patch(a.id, { currentBalance: { amount: 150, asOf: now } })).status).toBe(200);
  });
});

describe('account removal previews', () => {
  it('deletes empty manual accounts and snapshots, retaining creation keys against accidental resurrection', async () => {
    const a = await manual();
    const p = (await preview(a.id)).body;
    expect(p).toMatchObject({
      allowed: true,
      blockers: [],
      counts: { transactions: 0, balanceSnapshots: 1 },
      defaultCash: null,
    });
    expect((await remove(a.id)).status).toBe(200);
    expect((await detail(a.id)).status).toBe(404);
    expect(
      (await api('DELETE', `/v1/accounts/${a.id}`, { previewToken: p.previewToken })).status,
    ).toBe(404);
    expect((await api('POST', '/v1/accounts/manual', manualRequest)).body).toMatchObject({
      error: 'account_missing',
    });
    expect(
      (await api('POST', '/v1/accounts/manual', { ...manualRequest, name: 'Different' })).body,
    ).toMatchObject({ error: 'idempotency_conflict' });
    expect((await db.prepare('SELECT * FROM balance_snapshots').all()).results).toEqual([]);
  });
  it('refuses nonempty cash accounts and invalidates stale preview tokens', async () => {
    const a = await cash();
    const p = (await preview(a.id)).body;
    const t = await entry(a);
    expect((await preview(a.id)).body).toMatchObject({
      allowed: false,
      blockers: ['account_not_empty'],
    });
    expect((await remove(a.id)).body).toMatchObject({ error: 'account_delete_refused' });
    expect((await api('DELETE', `/v1/transactions/${t.id}`)).status).toBe(200);
    expect(
      (await api('DELETE', `/v1/accounts/${a.id}`, { previewToken: p.previewToken })).body,
    ).toMatchObject({ error: 'account_changed' });
    expect((await remove(a.id)).status).toBe(200);
  });
  it('keeps originals/history after import undo, detaching direct references', async () => {
    const a = await manual();
    const imported = await api<{ preview: { importId: string } }>(
      'POST',
      '/v1/imports',
      upload(
        { accountId: a.id },
        'Date,Description,Amount\n2026-01-01,Invented,-1.00\n',
        'invented.csv',
      ),
    );
    const id = imported.body.preview.importId;
    expect((await api('POST', `/v1/imports/${id}/commit`, {})).status).toBe(200);
    expect((await remove(a.id)).status).toBe(409);
    expect((await api('DELETE', `/v1/imports/${id}/transactions`)).status).toBe(200);
    expect((await preview(a.id)).body.detaches.imports).toBe(1);
    expect((await remove(a.id)).status).toBe(200);
    expect(
      await db.prepare('SELECT account_id FROM imports WHERE id = ?').bind(id).first('account_id'),
    ).toBeNull();
    const file = await client().raw(`/v1/vault/${id}/file`, {
      headers: { authorization: 'Bearer test-app-token' },
    });
    expect(await file.text()).toContain('Invented');
  });
  it('refuses goals and rules even when the rule is disabled', async () => {
    const a = await manual();
    await db
      .prepare(
        "INSERT INTO goals VALUES ('goal', 'Invented', 'savings', 100, 'USD', NULL, ?, NULL, 'c1')",
      )
      .bind(JSON.stringify([a.id]))
      .run();
    await db
      .prepare("INSERT INTO rules VALUES ('rule', 'Invented', 0, 1, 'all', ?, '[]', 'user', ?, ?)")
      .bind(JSON.stringify([{ field: 'accountId', op: 'in', value: [a.id] }]), now, now)
      .run();
    expect((await preview(a.id)).body).toMatchObject({
      allowed: false,
      blockers: ['account_in_use'],
      counts: { goals: 1, rules: 1 },
    });
    expect((await remove(a.id)).status).toBe(409);
  });
  it('promotes the remaining wallet; last deletion creates nothing until quick-add', async () => {
    const a = await cash();
    const b = await addAccount({ type: 'cash', name: 'Spare', balance: 700 });
    expect((await preview(a.id)).body.defaultCash).toEqual({
      wasDefault: true,
      nextAccountId: b.id,
      createsOnNextUse: false,
    });
    expect((await remove(a.id)).status).toBe(200);
    expect((await detail(b.id)).body.account.isDefaultCash).toBe(true);
    expect((await preview(b.id)).body.defaultCash).toEqual({
      wasDefault: true,
      nextAccountId: null,
      createsOnNextUse: true,
    });
    expect((await remove(b.id)).status).toBe(200);
    expect((await api<{ accounts: Account[] }>('GET', '/v1/accounts')).body.accounts).toEqual([]);
    const t = await api<{ transaction: Transaction }>('POST', '/v1/cash', {
      amount: -100,
      currency: 'USD',
      date: '2026-11-13',
    });
    expect(t.status).toBe(201);
    expect([a.id, b.id]).not.toContain(t.body.transaction.accountId);
  });
});

describe('cash entry removal', () => {
  it('reverses the recorded effect once, even after editing the visible amount', async () => {
    const a = await cash();
    const t = await entry(a);
    expect((await api('PATCH', `/v1/transactions/${t.id}`, { amount: -900 })).status).toBe(200);
    const result = await api('DELETE', `/v1/transactions/${t.id}`);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      deletedTransactionId: t.id,
      reversedBalanceAmount: -500,
      account: { balance: 10000 },
    });
    expect((await api('DELETE', `/v1/transactions/${t.id}`)).status).toBe(404);
    expect((await detail(a.id)).body.account.balance).toBe(10000);
  });
  it('treats an explicit balance as baseline, so older deletions do not alter it', async () => {
    const a = await cash();
    const t = await entry(a);
    expect((await patch(a.id, { currentBalance: { amount: 8000, asOf: now } })).status).toBe(200);
    expect((await api('DELETE', `/v1/transactions/${t.id}`)).body).toMatchObject({
      reversedBalanceAmount: 0,
      account: { balance: 8000 },
    });
    const newer = await entry(a, 300);
    expect((await api('DELETE', `/v1/transactions/${newer.id}`)).body).toMatchObject({
      reversedBalanceAmount: 300,
      account: { balance: 8000 },
    });
  });
  it('keeps unknown cash balances unknown across quick-add and deletion', async () => {
    const a = await cash();
    expect((await patch(a.id, { currentBalance: null })).status).toBe(200);
    const t = await entry(a);
    expect((await detail(a.id)).body.account).toMatchObject({
      balance: 0,
      includeInNetWorth: false,
      manualBalance: { currentKnown: false },
    });
    expect((await api('DELETE', `/v1/transactions/${t.id}`)).body).toMatchObject({
      reversedBalanceAmount: 0,
      account: { balance: 0, manualBalance: { currentKnown: false } },
    });
  });
  it('refuses imported, provider, ATM, split or linked entries', async () => {
    const a = await cash();
    for (const changes of [
      { source: 'import' as const },
      { externalId: 'atm:invented' },
      { importFingerprint: 'invented' },
      { connectionId: 'invented' },
      { isSplitParent: true },
      { splitParentId: 'invented' },
      { transferLinkId: 'invented' },
    ]) {
      const t = await addTxn(a, { date: '2026-11-13', amount: -100, source: 'manual', ...changes });
      expect((await api('DELETE', `/v1/transactions/${t.id}`)).body).toMatchObject({
        error: 'cash_delete_refused',
      });
    }
  });
  it('requires an explicit baseline for ambiguous legacy amount edits', async () => {
    const a = await cash();
    const t = await addTxn(a, {
      date: '2026-11-13',
      source: 'manual',
      amount: -100,
      userEditedFields: ['amount'],
    });
    expect((await api('DELETE', `/v1/transactions/${t.id}`)).body).toMatchObject({
      error: 'cash_balance_unknown',
    });
    expect((await patch(a.id, { currentBalance: { amount: 10000, asOf: now } })).status).toBe(200);
    expect((await api('DELETE', `/v1/transactions/${t.id}`)).status).toBe(200);
  });
  it('deletes alerts, detaches receipts, keeps originals and other entries', async () => {
    const a = await cash();
    const t = await entry(a);
    const other = await entry(a, -250);
    await db
      .prepare(
        "INSERT INTO receipts (id,r2_key,line_items,matched_transaction_id,status,created_at,updated_at) VALUES ('receipt','invented-receipt','[]',?,'matched',?,?)",
      )
      .bind(t.id, now, now)
      .run();
    await testEnv.FILES.put('invented-receipt', 'invented original');
    await db
      .prepare("UPDATE transactions SET receipt_id = 'receipt' WHERE id = ?")
      .bind(t.id)
      .run();
    await db
      .prepare(
        "INSERT INTO alerts (id,type,transaction_id,message,created_at) VALUES ('alert','unusual',?,'Invented',?)",
      )
      .bind(t.id, now)
      .run();
    expect((await api('DELETE', `/v1/transactions/${t.id}`)).status).toBe(200);
    expect(
      await db
        .prepare("SELECT status, matched_transaction_id FROM receipts WHERE id = 'receipt'")
        .first(),
    ).toEqual({ status: 'needs_review', matched_transaction_id: null });
    expect(await (await testEnv.FILES.get('invented-receipt'))!.text()).toBe('invented original');
    expect((await db.prepare('SELECT * FROM alerts').all()).results).toEqual([]);
    expect((await allTxns()).map((x) => x.id)).toEqual([other.id]);
  });
  it('authenticates new routes and bounds deletion queries', async () => {
    const a = await cash();
    const t = await entry(a);
    for (const [method, url] of [
      ['GET', `/v1/accounts/${a.id}`],
      ['PATCH', `/v1/accounts/${a.id}`],
      ['GET', `/v1/accounts/${a.id}/deletion-preview`],
      ['DELETE', `/v1/accounts/${a.id}`],
      ['DELETE', `/v1/transactions/${t.id}`],
    ])
      expect((await api(method!, url!, undefined, null)).status).toBe(401);
    const meter = meterDb(db);
    expect(
      (await client({}, { ...testEnv, DB: meter.db }).api('DELETE', `/v1/transactions/${t.id}`))
        .status,
    ).toBe(200);
    expect(meter.used()).toBeLessThan(30);
  });
});

/** Mutate the real local database immediately before the tested atomic batch. */
function interleave(action: () => Promise<void>) {
  let pending = true;
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (pending) {
            pending = false;
            await action();
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('deletion and editing races', () => {
  it('fences an edit changed after validation and rolls back every snapshot/metadata write', async () => {
    const a = await manual();
    const version = (await detail(a.id)).body.version;
    const raced = interleave(async () => {
      await db.prepare("UPDATE accounts SET name = 'Concurrent' WHERE id = ?").bind(a.id).run();
    });
    const result = await client({}, { ...testEnv, DB: raced }).api(
      'PATCH',
      `/v1/accounts/${a.id}`,
      {
        expectedVersion: version,
        name: 'Overwrite',
        currentBalance: { amount: 100, asOf: now },
      },
    );
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ error: 'account_changed' });
    expect((await detail(a.id)).body.account).toMatchObject({
      name: 'Concurrent',
      manualBalance: { currentKnown: false },
    });
    expect((await db.prepare('SELECT * FROM manual_balance_overrides').all()).results).toEqual([]);
    expect((await db.prepare('SELECT * FROM account_write_guard').all()).results).toEqual([]);
  });
  it('fences deletion if a transaction arrives after the preview check', async () => {
    const a = await manual();
    const p = (await preview(a.id)).body;
    const raced = interleave(async () => {
      await addTxn(a, { date: '2026-01-01', amount: -100 });
    });
    const result = await client({}, { ...testEnv, DB: raced }).api(
      'DELETE',
      `/v1/accounts/${a.id}`,
      { previewToken: p.previewToken },
    );
    expect(result.status).toBe(409);
    expect((await detail(a.id)).status).toBe(200);
    expect(await allTxns()).toHaveLength(1);
    expect((await db.prepare('SELECT * FROM deleted_manual_accounts').all()).results).toEqual([]);
  });
  it('fences a cash reversal if another entry changes its account balance', async () => {
    const a = await cash();
    const t = await entry(a);
    const raced = interleave(async () => {
      await entry(a, -250);
    });
    const result = await client({}, { ...testEnv, DB: raced }).api(
      'DELETE',
      `/v1/transactions/${t.id}`,
    );
    expect(result.status).toBe(409);
    expect((await detail(a.id)).body.account.balance).toBe(9250);
    expect(await allTxns()).toHaveLength(2);
    expect((await api('DELETE', `/v1/transactions/${t.id}`)).status).toBe(200);
    expect((await detail(a.id)).body.account.balance).toBe(9750);
  });
  it('rolls back reversal and receipt/alert cleanup when the final transaction delete fails', async () => {
    const a = await cash();
    const t = await entry(a);
    await db
      .prepare(
        "CREATE TRIGGER fail_cash_delete BEFORE DELETE ON transactions BEGIN SELECT RAISE(ABORT, 'injected'); END",
      )
      .run();
    try {
      expect((await api('DELETE', `/v1/transactions/${t.id}`)).status).toBe(500);
    } finally {
      await db.prepare('DROP TRIGGER fail_cash_delete').run();
    }
    expect((await detail(a.id)).body.account.balance).toBe(9500);
    expect((await db.prepare('SELECT * FROM cash_entry_effects').all()).results).toHaveLength(1);
    expect(await allTxns()).toHaveLength(1);
    expect((await api('DELETE', `/v1/transactions/${t.id}`)).status).toBe(200);
  });
  it('does not insert a quick-add into an account deleted during its read', async () => {
    const a = await cash();
    const raced = interleave(async () => {
      expect((await remove(a.id)).status).toBe(200);
    });
    const result = await client({}, { ...testEnv, DB: raced }).api('POST', '/v1/cash', {
      accountId: a.id,
      amount: -100,
      currency: 'USD',
      date: '2026-11-13',
    });
    expect(result.status).toBe(409);
    expect(await allTxns()).toEqual([]);
    expect((await db.prepare('SELECT * FROM cash_entry_effects').all()).results).toEqual([]);
  });
  it('does not split an entry deleted during its read', async () => {
    const a = await cash();
    const t = await entry(a);
    const raced = interleave(async () => {
      expect((await api('DELETE', `/v1/transactions/${t.id}`)).status).toBe(200);
    });
    const result = await client({}, { ...testEnv, DB: raced }).api(
      'POST',
      `/v1/transactions/${t.id}/split`,
      {
        idempotencyKey: 'invented-split',
        lines: [
          { amount: -200, categoryId: null },
          { amount: -300, categoryId: null },
        ],
      },
    );
    expect(result.status).toBe(409);
    expect(await allTxns()).toEqual([]);
    expect((await db.prepare('SELECT * FROM split_locks').all()).results).toEqual([]);
  });
  it('allows one of overlapping removals and never reverses twice', async () => {
    const a = await cash();
    const t = await entry(a);
    const results = await Promise.all([
      api('DELETE', `/v1/transactions/${t.id}`),
      api('DELETE', `/v1/transactions/${t.id}`),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.every((r) => [200, 404, 409].includes(r.status))).toBe(true);
    expect((await detail(a.id)).body.account.balance).toBe(10000);
  });
  it('blocks account deletion during any import save, including a multi-account save', async () => {
    const a = await manual();
    const imported = await api<{ preview: { importId: string } }>(
      'POST',
      '/v1/imports',
      upload(
        { accountId: a.id },
        'Date,Description,Amount\n2026-01-01,Invented,-1.00\n',
        'invented.csv',
      ),
    );
    await db
      .prepare("UPDATE imports SET status = 'committing', account_id = NULL WHERE id = ?")
      .bind(imported.body.preview.importId)
      .run();
    expect((await preview(a.id)).body.blockers).toContain('import_in_progress');
    expect((await remove(a.id)).status).toBe(409);
  });
  it('edits and removes an actual import-created account after undo', async () => {
    const imported = await api<{ preview: { importId: string } }>(
      'POST',
      '/v1/imports',
      upload(
        {},
        'date,account,category,amount,currency,converted amount,currency,description\n10-23-25,Invented wallet,Books,-3.00,USD,-3.00,USD,Invented book',
        'invented-monefy.csv',
      ),
    );
    const id = imported.body.preview.importId;
    expect((await api('POST', `/v1/imports/${id}/commit`, {})).status).toBe(200);
    const a = (await api<{ accounts: Account[] }>('GET', '/v1/accounts')).body.accounts[0]!;
    expect(
      (await patch(a.id, { name: 'Imported bank', type: 'checking', currentBalance: null })).body
        .account,
    ).toMatchObject({
      name: 'Imported bank',
      type: 'checking',
      manualBalance: { currentKnown: false },
    });
    expect((await remove(a.id)).status).toBe(409);
    expect((await api('DELETE', `/v1/imports/${id}/transactions`)).status).toBe(200);
    expect((await remove(a.id)).status).toBe(200);
  });
});

describe('additional account dependency protections', () => {
  it('blocks kind changes and deletion with investment records', async () => {
    const a = await addAccount({ type: 'brokerage' });
    await db
      .prepare(
        `INSERT INTO holdings (id,account_id,security_id,quantity,price,price_as_of,market_value,currency,source)
      VALUES ('holding',?,'invented-security','1','100',?,10000,'USD','manual')`,
      )
      .bind(a.id, now)
      .run();
    expect((await patch(a.id, { type: 'checking' })).body).toMatchObject({
      error: 'account_kind_conflict',
    });
    expect((await preview(a.id)).body).toMatchObject({
      allowed: false,
      counts: { holdings: 1 },
      blockers: ['account_in_use'],
    });
    expect((await remove(a.id)).status).toBe(409);
    expect((await patch(a.id, { name: 'Renamed investment' })).status).toBe(200);
  });
  it('refuses deletion while a recurring item refers to an otherwise empty account', async () => {
    const a = await manual();
    await db
      .prepare(
        `INSERT INTO recurring_items (id,name,account_id,kind,frequency,expected_amount,currency,status,detected_by)
      VALUES ('recurring','Invented',?,'subscription','monthly',100,'USD','cancelled','user')`,
      )
      .bind(a.id)
      .run();
    expect((await preview(a.id)).body).toMatchObject({
      allowed: false,
      counts: { recurringItems: 1 },
      blockers: ['account_in_use'],
    });
  });
  it('refuses a provider account even when empty', async () => {
    const a = await addAccount({ type: 'checking', connectionId: 'invented' });
    expect((await preview(a.id)).body.blockers).toContain('account_connected');
    expect((await remove(a.id)).body).toMatchObject({ error: 'account_delete_refused' });
  });
  it('bounds account edit/delete query counts with 1500 snapshots and refuses a larger cleanup', async () => {
    const a = await manual();
    await db
      .prepare(
        `WITH RECURSIVE days(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM days WHERE n < 1499)
      INSERT INTO balance_snapshots SELECT ?, date('2020-01-01', '+' || n || ' days'), 100, 'USD' FROM days`,
      )
      .bind(a.id)
      .run();
    const meter = meterDb(db);
    const measured = client({}, { ...testEnv, DB: meter.db }).api;
    const d = await measured<Detail>('GET', `/v1/accounts/${a.id}`);
    expect(
      (
        await measured('PATCH', `/v1/accounts/${a.id}`, {
          expectedVersion: d.body.version,
          currentBalance: { amount: 200, asOf: now },
        })
      ).status,
    ).toBe(200);
    const p = await measured<Preview>('GET', `/v1/accounts/${a.id}/deletion-preview`);
    expect(
      (await measured('DELETE', `/v1/accounts/${a.id}`, { previewToken: p.body.previewToken }))
        .status,
    ).toBe(200);
    expect(meter.used()).toBeLessThan(30); // all four HTTP calls together
    const b = await addAccount({ type: 'checking' });
    await db
      .prepare(
        `WITH RECURSIVE days(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM days WHERE n < 2000)
      INSERT INTO balance_snapshots SELECT ?, date('2020-01-01', '+' || n || ' days'), 100, 'USD' FROM days`,
      )
      .bind(b.id)
      .run();
    expect((await preview(b.id)).body.blockers).toContain('account_delete_too_large');
    expect((await remove(b.id)).status).toBe(409);
  });
});
