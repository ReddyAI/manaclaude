import { describe, expect, it } from 'vitest';
import type { ProviderTransaction, Transaction } from '@manaclaude/shared';
import { planTransactionSync, type TransactionSyncInput } from '../src/sync';
import { providerTransaction } from '../src/kit';

const NOW = '2026-11-05T12:00:00.000Z';
const ACCOUNTS = new Map([['ext_chk', 'acc_chk']]);

let counter = 0;
const newId = (kind: string) => `${kind}_new${++counter}`;

function row(over: Partial<Transaction> = {}): Transaction {
  return {
    id: 'txn_1',
    accountId: 'acc_chk',
    date: '2026-11-01',
    amount: -450,
    currency: 'USD',
    originalAmount: -450,
    originalCurrency: 'USD',
    name: 'Corner Coffee',
    rawName: 'CORNER COFFEE 0412',
    merchantId: null,
    categoryId: null,
    categorySource: null,
    aiCategoryConfidence: null,
    kind: 'regular',
    pending: false,
    notes: null,
    tagIds: [],
    excluded: false,
    transferLinkId: null,
    receiptId: null,
    recurringId: null,
    splitParentId: null,
    isSplitParent: false,
    reviewed: false,
    reviewedAt: null,
    userEditedFields: [],
    source: 'connector',
    connectionId: 'conn_1',
    externalId: 'p1',
    pendingExternalId: null,
    importId: null,
    importFingerprint: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  };
}

function incoming(over: Partial<ProviderTransaction> = {}): ProviderTransaction {
  return providerTransaction({
    externalId: 'p1',
    accountExternalId: 'ext_chk',
    date: '2026-11-01',
    amount: -450,
    currency: 'USD',
    rawName: 'CORNER COFFEE 0412',
    merchantName: 'Corner Coffee',
    ...over,
  });
}

function plan(
  existing: Transaction[],
  transactions: ProviderTransaction[],
  extra: Partial<TransactionSyncInput> & { removed?: string[]; deltaOnly?: boolean } = {},
) {
  const { removed, deltaOnly, ...rest } = extra;
  return planTransactionSync({
    connectionId: 'conn_1',
    accounts: ACCOUNTS,
    existing,
    result: { transactions, removedTransactionExternalIds: removed ?? [], deltaOnly },
    now: NOW,
    newId,
    ...rest,
  });
}

describe('transaction sync: inserts', () => {
  it('creates a full row from a provider row, keeping the sign and filling original amount', () => {
    const out = plan([], [incoming({ amount: -1234, categoryHint: 'Dining' })]);
    expect(out.inserts).toHaveLength(1);
    expect(out.inserts[0]).toMatchObject({
      accountId: 'acc_chk',
      amount: -1234,
      originalAmount: -1234,
      originalCurrency: 'USD',
      name: 'Corner Coffee',
      rawName: 'CORNER COFFEE 0412',
      source: 'connector',
      connectionId: 'conn_1',
      externalId: 'p1',
      kind: 'regular',
      categoryId: null,
      userEditedFields: [],
      reviewed: false,
    });
    expect(out.categoryHints).toEqual({ p1: 'Dining' });
  });

  it('keeps a foreign-currency original and takes kind from a transfer hint on new rows only', () => {
    const out = plan(
      [],
      [incoming({ originalAmount: -4250, originalCurrency: 'EUR', kindHint: 'transfer' })],
    );
    expect(out.inserts[0]).toMatchObject({
      originalAmount: -4250,
      originalCurrency: 'EUR',
      kind: 'transfer',
    });
    const again = plan(out.inserts, [
      incoming({ originalAmount: -4250, originalCurrency: 'EUR', kindHint: 'regular' }),
    ]);
    expect(again.updates).toEqual([]);
  });

  it('skips provider rows for accounts that are not linked and counts them', () => {
    const out = plan([], [incoming({ accountExternalId: 'somewhere_else' })]);
    expect(out.inserts).toEqual([]);
    expect(out.stats.unmappedAccount).toBe(1);
  });
});

describe('transaction sync: dedupe by provider id', () => {
  it('a repeated sync with the same rows changes nothing', () => {
    const first = plan([], [incoming(), incoming({ externalId: 'p2', amount: -999 })]);
    const second = plan(first.inserts, [incoming(), incoming({ externalId: 'p2', amount: -999 })]);
    expect(second.inserts).toEqual([]);
    expect(second.updates).toEqual([]);
    expect(second.removals).toEqual([]);
  });

  it('two identical real purchases with different provider ids are both kept, then stay two', () => {
    const a = incoming({ externalId: 'coffee_a' });
    const b = incoming({ externalId: 'coffee_b' });
    const first = plan([], [a, b]);
    expect(first.inserts).toHaveLength(2);
    const second = plan(first.inserts, [a, b]);
    expect(second.inserts).toEqual([]);
    expect(second.updates).toEqual([]);
  });

  it('the same provider id twice in one result is one transaction', () => {
    const out = plan([], [incoming(), incoming({ rawName: 'CORNER COFFEE 0412 (updated)' })]);
    expect(out.inserts).toHaveLength(1);
    expect(out.stats.repeatedInResult).toBe(1);
    expect(out.inserts[0]?.rawName).toContain('updated');
  });

  it('only rows of the linked accounts take part', () => {
    const other = row({ id: 'txn_other', accountId: 'acc_other', externalId: 'p1' });
    const out = plan([other], [incoming()]);
    expect(out.inserts).toHaveLength(1);
    expect(out.updates).toEqual([]);
  });
});

describe('transaction sync: user edits survive', () => {
  it('a user-edited category survives the next sync, even when the provider changes other fields', () => {
    const edited = row({
      categoryId: 'cat_coffee_shops',
      categorySource: 'user',
      userEditedFields: ['categoryId'],
      reviewed: true,
    });
    const out = plan(
      [edited],
      [incoming({ rawName: 'CORNER COFFEE 0412 SEATTLE', categoryHint: 'Restaurants' })],
    );
    expect(out.updates).toHaveLength(1);
    const changes = out.updates[0]?.changes ?? {};
    expect(changes).not.toHaveProperty('categoryId');
    expect(changes).not.toHaveProperty('categorySource');
    expect(changes).not.toHaveProperty('reviewed');
    expect(changes.rawName).toBe('CORNER COFFEE 0412 SEATTLE');
  });

  it('never sets a category from the provider hint, even on a row with no edits', () => {
    const out = plan([row()], [incoming({ categoryHint: 'Restaurants' })]);
    expect(out.updates).toEqual([]);
  });

  it('user-edited name, amount and date are left alone; provider-owned fields still refresh', () => {
    const edited = row({
      name: 'My coffee',
      amount: -500,
      originalAmount: -500,
      date: '2026-11-02',
      userEditedFields: ['name', 'amount', 'date'],
    });
    const out = plan(
      [edited],
      [
        incoming({
          amount: -450,
          date: '2026-11-01',
          merchantName: 'Corner Coffee',
          rawName: 'CORNER COFFEE #2',
        }),
      ],
    );
    const changes = out.updates[0]?.changes ?? {};
    expect(changes).not.toHaveProperty('name');
    expect(changes).not.toHaveProperty('amount');
    expect(changes).not.toHaveProperty('originalAmount');
    expect(changes).not.toHaveProperty('date');
    expect(changes.rawName).toBe('CORNER COFFEE #2');
  });

  it('notes, tags, kind and excluded are never touched', () => {
    const edited = row({
      notes: 'with Sam',
      tagIds: ['tag_1'],
      kind: 'transfer',
      excluded: true,
      userEditedFields: ['notes', 'tagIds', 'kind', 'excluded'],
    });
    const out = plan([edited], [incoming({ rawName: 'CHANGED' })]);
    const changes = out.updates[0]?.changes ?? {};
    for (const k of ['notes', 'tagIds', 'kind', 'excluded'] as const)
      expect(changes).not.toHaveProperty(k);
  });

  it('a posted row never goes back to pending', () => {
    const out = plan([row({ pending: false })], [incoming({ pending: true })]);
    expect(out.updates).toEqual([]);
  });
});

describe('transaction sync: pending to posted', () => {
  const pending = row({
    id: 'txn_pend',
    externalId: 'pend_1',
    pending: true,
    date: '2026-11-03',
    userEditedFields: ['categoryId'],
    categoryId: 'cat_x',
  });

  it('uses pendingExternalId when the provider gives it, keeping the row id and its edits', () => {
    const out = plan(
      [pending],
      [incoming({ externalId: 'post_1', date: '2026-11-04', pendingExternalId: 'pend_1' })],
    );
    expect(out.inserts).toEqual([]);
    expect(out.stats.postedFromPending).toBe(1);
    expect(out.updates).toHaveLength(1);
    expect(out.updates[0]).toMatchObject({ id: 'txn_pend', reason: 'posted_from_pending' });
    expect(out.updates[0]?.changes).toMatchObject({
      externalId: 'post_1',
      pendingExternalId: 'pend_1',
      pending: false,
      date: '2026-11-04',
    });
    expect(out.updates[0]?.changes).not.toHaveProperty('categoryId');
  });

  it('does not remove the converted row even when the provider also lists the old pending id as removed', () => {
    const out = plan([pending], [incoming({ externalId: 'post_1', pendingExternalId: 'pend_1' })], {
      removed: ['pend_1'],
    });
    expect(out.removals).toEqual([]);
  });

  it('falls back to amount, currency and a date window when the provider gives no link', () => {
    const out = plan([pending], [incoming({ externalId: 'post_2', date: '2026-11-05' })]);
    expect(out.stats.postedFromPending).toBe(1);
    expect(out.updates[0]?.changes).toMatchObject({
      externalId: 'post_2',
      pendingExternalId: 'pend_1',
      pending: false,
    });
  });

  it('does not match when the amount differs, the posted date is before the hold, or the window is passed', () => {
    for (const over of [{ amount: -451 }, { date: '2026-11-02' }, { date: '2026-11-20' }]) {
      const out = plan([pending], [incoming({ externalId: 'post_3', ...over })], {
        options: { pendingExpiryDays: null },
      });
      expect(out.stats.postedFromPending, JSON.stringify(over)).toBe(0);
      expect(out.inserts).toHaveLength(1);
    }
  });

  it('can be turned off', () => {
    const out = plan([pending], [incoming({ externalId: 'post_4', date: '2026-11-05' })], {
      options: { heuristicPendingMatch: false },
    });
    expect(out.stats.postedFromPending).toBe(0);
    expect(out.inserts).toHaveLength(1);
  });

  it('two identical holds are claimed one each by two identical posted rows', () => {
    const holdA = row({ id: 'h_a', externalId: 'ha', pending: true, date: '2026-11-03' });
    const holdB = row({ id: 'h_b', externalId: 'hb', pending: true, date: '2026-11-03' });
    const out = plan(
      [holdA, holdB],
      [
        incoming({ externalId: 'pa', date: '2026-11-04' }),
        incoming({ externalId: 'pb', date: '2026-11-04' }),
      ],
    );
    expect(out.stats.postedFromPending).toBe(2);
    expect(out.inserts).toEqual([]);
    expect(new Set(out.updates.map((u) => u.id))).toEqual(new Set(['h_a', 'h_b']));
  });

  it('one posted row claims only one of two identical holds; the other stays pending', () => {
    const holdA = row({ id: 'h_a', externalId: 'ha', pending: true, date: '2026-11-03' });
    const holdB = row({ id: 'h_b', externalId: 'hb', pending: true, date: '2026-11-03' });
    const out = plan([holdA, holdB], [incoming({ externalId: 'pa', date: '2026-11-04' })]);
    expect(out.updates).toHaveLength(1);
    expect(out.stats.postedFromPending).toBe(1);
  });

  it('prefers the hold with the same name when several match', () => {
    const other = row({
      id: 'h_other',
      externalId: 'ho',
      pending: true,
      date: '2026-11-04',
      name: 'Other Shop',
      rawName: 'OTHER SHOP',
    });
    const same = row({ id: 'h_same', externalId: 'hs', pending: true, date: '2026-11-03' });
    const out = plan([other, same], [incoming({ externalId: 'px', date: '2026-11-05' })]);
    expect(out.updates[0]?.id).toBe('h_same');
  });
});

describe('transaction sync: removals', () => {
  it('removes rows the provider says are gone and flags the ones with user edits', () => {
    const plain = row({ id: 'r1', externalId: 'gone1', pending: true });
    const edited = row({
      id: 'r2',
      externalId: 'gone2',
      pending: true,
      userEditedFields: ['categoryId'],
    });
    const out = plan([plain, edited], [], { removed: ['gone1', 'gone2', 'never_stored'] });
    expect(out.removals).toEqual([
      { id: 'r1', externalId: 'gone1', reason: 'provider_removed', hadUserEdits: false },
      { id: 'r2', externalId: 'gone2', reason: 'provider_removed', hadUserEdits: true },
    ]);
  });

  it('expires a pending hold that vanished without a replacement after 21 days', () => {
    const stale = row({ id: 'old', externalId: 'old_hold', pending: true, date: '2026-10-01' });
    const recent = row({ id: 'new', externalId: 'new_hold', pending: true, date: '2026-11-03' });
    const out = plan([stale, recent], []);
    expect(out.removals.map((r) => [r.id, r.reason])).toEqual([['old', 'pending_expired']]);
  });

  it('does not expire holds when the result is delta-only or when expiry is off', () => {
    const stale = row({ id: 'old', externalId: 'old_hold', pending: true, date: '2026-10-01' });
    expect(plan([stale], [], { deltaOnly: true }).removals).toEqual([]);
    expect(plan([stale], [], { options: { pendingExpiryDays: null } }).removals).toEqual([]);
  });

  it('keeps a hold the provider still reports', () => {
    const stale = row({ id: 'old', externalId: 'old_hold', pending: true, date: '2026-10-01' });
    const out = plan(
      [stale],
      [incoming({ externalId: 'old_hold', date: '2026-10-01', pending: true })],
    );
    expect(out.removals).toEqual([]);
  });
});

describe('transaction sync: claiming rows that came from a file or by hand', () => {
  const imported = row({
    id: 'imp_1',
    source: 'import',
    externalId: null,
    connectionId: null,
    importFingerprint: 'fp1',
    name: 'Coffee (from CSV)',
  });

  it('claims an unlinked row with the same account, amount and day, and keeps its name', () => {
    const out = plan([imported], [incoming({ externalId: 'p_new' })]);
    expect(out.inserts).toEqual([]);
    expect(out.stats.claimedUnlinked).toBe(1);
    expect(out.updates[0]).toMatchObject({ id: 'imp_1', reason: 'claimed_unlinked' });
    expect(out.updates[0]?.changes).toMatchObject({
      source: 'connector',
      externalId: 'p_new',
      connectionId: 'conn_1',
    });
    expect(out.updates[0]?.changes).not.toHaveProperty('name');
  });

  it('claims each file row at most once, so two identical coffees stay two', () => {
    const twin = row({
      id: 'imp_2',
      source: 'import',
      externalId: null,
      connectionId: null,
      importFingerprint: 'fp2',
    });
    const out = plan(
      [imported, twin],
      [incoming({ externalId: 'a' }), incoming({ externalId: 'b' }), incoming({ externalId: 'c' })],
    );
    expect(out.stats.claimedUnlinked).toBe(2);
    expect(out.inserts).toHaveLength(1);
  });

  it('does not claim across a different date or amount, or when switched off', () => {
    expect(
      plan([imported], [incoming({ externalId: 'x', date: '2026-11-02' })]).inserts,
    ).toHaveLength(1);
    expect(plan([imported], [incoming({ externalId: 'x', amount: -451 })]).inserts).toHaveLength(1);
    expect(
      plan([imported], [incoming({ externalId: 'x' })], { options: { claimUnlinked: false } })
        .inserts,
    ).toHaveLength(1);
    expect(
      plan([imported], [incoming({ externalId: 'x', date: '2026-11-02' })], {
        options: { claimDateWindowDays: 1 },
      }).stats.claimedUnlinked,
    ).toBe(1);
  });

  it('never claims a pending provider row or a split parent', () => {
    const parent = row({
      id: 'split_parent',
      source: 'manual',
      externalId: null,
      connectionId: null,
      isSplitParent: true,
    });
    expect(
      plan([imported], [incoming({ externalId: 'x', pending: true })]).stats.claimedUnlinked,
    ).toBe(0);
    expect(plan([parent], [incoming({ externalId: 'x' })]).stats.claimedUnlinked).toBe(0);
  });
});
