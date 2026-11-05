import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_MONEY_POLICIES, type MoneyPolicies, type SyncResult } from '@manaclaude/shared';
import coffeesCsv from './fixtures/imports/checking-two-coffees.csv?raw';
import { insertStatement, selectAll } from '../src/db/table';
import { connectionsTable, rulesTable, transferLinksTable } from '../src/db/tables';
import { commitImport, previewImport } from '../src/imports/service';
import { runCategorization } from '../src/ai/jobs/categorize';
import { editTransaction } from '../src/services/edits';
import { confirmLink, linkManually, rejectLink } from '../src/services/links';
import { runTransferMatcher } from '../src/services/matcher';
import { runRules } from '../src/services/rules';
import { splitTransaction, undoSplit } from '../src/services/splits';
import { getTransaction } from '../src/services/transactions';
import { applySyncResult } from '../src/sync/apply';
import { fakeAi } from './fakes';
import {
  addAccount,
  addRate,
  addTxn,
  allTxns,
  db,
  file,
  freshDb,
  spending,
  testEnv,
} from './helpers';

/**
 * The five build checks from research/sure/rea.md, against a local D1
 * database, with the default money policies from the brief. Case numbers
 * match docs/backend-plan.md.
 */

beforeEach(async () => {
  await freshDb();
});

const links = () => selectAll(db, transferLinksTable, '', [], 'created_at');

describe('check 1: no double counting of transfers and card payments', () => {
  it('1.1 a $200 card purchase plus its $200 payment from checking reports $200 of spending', async () => {
    const checking = await addAccount({ type: 'checking' });
    const card = await addAccount({ type: 'credit_card' });
    await addTxn(card, {
      date: '2026-10-03',
      amount: -20_000,
      rawName: 'LAKESHORE OUTFITTERS',
      categoryId: 'cat_shopping',
    });
    await addTxn(checking, {
      date: '2026-10-25',
      amount: -20_000,
      rawName: 'LAKESHORE CARD PAYMENT',
    });
    await addTxn(card, { date: '2026-10-25', amount: 20_000, rawName: 'PAYMENT - THANK YOU' });
    expect(await runTransferMatcher(db)).toEqual({ linked: 1, suggested: 0 });
    const s = await spending('2026-10-01', '2026-10-31');
    expect(s.spending).toBe(20_000);
    expect(s.byCategory).toEqual({ cat_shopping: 20_000 });
    expect(s.income).toBe(0);
  });

  it('1.1 the matcher links checking -$200 and card +$200 within 5 days as one card_payment link', async () => {
    const checking = await addAccount({ type: 'checking' });
    const card = await addAccount({ type: 'credit_card' });
    const out = await addTxn(checking, {
      date: '2026-10-25',
      amount: -20_000,
      rawName: 'LAKESHORE CARD PAYMENT',
    });
    const into = await addTxn(card, {
      date: '2026-10-27',
      amount: 20_000,
      rawName: 'PAYMENT - THANK YOU',
    });
    await runTransferMatcher(db);
    const all = await links();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      kind: 'card_payment',
      status: 'auto',
      outTransactionId: out.id,
      inTransactionId: into.id,
      impliedRate: 1,
    });
    expect((await getTransaction(db, out.id))?.transferLinkId).toBe(all[0]!.id);
    expect((await getTransaction(db, into.id))?.transferLinkId).toBe(all[0]!.id);
  });

  it('1.2 checking -$1,000 and savings +$1,000 a day later link as a transfer and leave spending and income alone', async () => {
    const checking = await addAccount({ type: 'checking' });
    const savings = await addAccount({ type: 'savings' });
    await addTxn(checking, { date: '2026-11-03', amount: -100_000 });
    await addTxn(savings, { date: '2026-11-04', amount: 100_000 });
    await runTransferMatcher(db);
    expect((await links()).map((l) => [l.kind, l.status])).toEqual([['transfer', 'auto']]);
    const s = await spending('2026-11-01', '2026-11-30');
    expect(s.spending).toBe(0);
    expect(s.income).toBe(0);
  });

  it('1.3 USD 2,000 out and INR 1,76,240 in two days later links as one transfer with impliedRate 88.12', async () => {
    const checking = await addAccount({ type: 'checking' });
    const nre = await addAccount({ type: 'savings', subtype: 'nre', currency: 'INR' });
    await addRate('2026-10-15', 'INR', 88.0);
    const out = await addTxn(checking, {
      date: '2026-10-15',
      amount: -200_000,
      rawName: 'WISE US INC',
    });
    const into = await addTxn(nre, {
      date: '2026-10-17',
      amount: 17_624_000,
      rawName: 'INWARD REMITTANCE',
    });
    await runTransferMatcher(db);
    const [link] = await links();
    expect(link).toMatchObject({
      kind: 'transfer',
      status: 'auto',
      outAmount: 200_000,
      outCurrency: 'USD',
      inAmount: 17_624_000,
      inCurrency: 'INR',
    });
    expect(link!.impliedRate).toBeCloseTo(88.12, 10);
    expect((await getTransaction(db, out.id))?.amount).toBe(-200_000);
    expect((await getTransaction(db, into.id))?.amount).toBe(17_624_000);
    const s = await spending('2026-10-01', '2026-10-31');
    expect(s.spending).toBe(0);
    expect(s.income).toBe(0);
  });

  it('1.3 a cross-currency pair more than 2% off the day rate is not linked', async () => {
    const checking = await addAccount({ type: 'checking' });
    const nre = await addAccount({ type: 'savings', subtype: 'nre', currency: 'INR' });
    await addRate('2026-10-15', 'INR', 88.0);
    await addTxn(checking, { date: '2026-10-15', amount: -200_000, rawName: 'WISE US INC' });
    await addTxn(nre, { date: '2026-10-17', amount: 17_000_000, rawName: 'INWARD REMITTANCE' }); // 3.4% off
    expect(await runTransferMatcher(db)).toEqual({ linked: 0, suggested: 0 });
  });

  it('1.4 an ATM withdrawal links to the cash account deposit as atm_withdrawal; later cash purchases count', async () => {
    const checking = await addAccount({ type: 'checking' });
    const cash = await addAccount({ type: 'cash', isDefaultCash: true });
    await addTxn(checking, {
      date: '2026-10-28',
      amount: -20_000,
      rawName: 'ATM WITHDRAWAL 1123 MAIN ST',
    });
    await addTxn(cash, { date: '2026-10-28', amount: 20_000, rawName: 'Cash' });
    await addTxn(cash, {
      date: '2026-10-29',
      amount: -1_500,
      rawName: 'Farmers market',
      categoryId: 'cat_groceries',
    });
    await runTransferMatcher(db);
    expect((await links()).map((l) => [l.kind, l.status])).toEqual([['atm_withdrawal', 'auto']]);
    const s = await spending('2026-10-01', '2026-10-31');
    expect(s.spending).toBe(1_500);
    expect(s.byCategory).toEqual({ cat_groceries: 1_500 });
  });

  it('1.4 an imported ATM withdrawal creates its cash deposit and links it, once', async () => {
    const checking = await addAccount({ type: 'checking' });
    const csv = 'Date,Description,Amount\n10/28/2026,ATM WITHDRAWAL 1123 MAIN ST,-200.00\n';
    const preview = await previewImport(testEnv, {
      ...file(csv, 'atm.csv'),
      accountId: checking.id,
    });
    const result = await commitImport(testEnv, preview.importId);
    expect(result.linked).toBe(1);
    const [link] = await links();
    expect(link?.kind).toBe('atm_withdrawal');
    const cashSide = await getTransaction(db, link!.inTransactionId);
    expect(cashSide).toMatchObject({ amount: 20_000, currency: 'USD' });
    // Running the matcher again changes nothing.
    expect(await runTransferMatcher(db)).toEqual({ linked: 0, suggested: 0 });
    expect(await links()).toHaveLength(1);
  });

  it('1.5 several candidates create suggested links that do not count until confirmed', async () => {
    const checking = await addAccount({ type: 'checking' });
    const savings = await addAccount({ type: 'savings' });
    const out = await addTxn(checking, {
      date: '2026-11-02',
      amount: -50_000,
      rawName: 'ONLINE TRANSFER',
    });
    const a = await addTxn(savings, { date: '2026-11-02', amount: 50_000, rawName: 'DEPOSIT' });
    await addTxn(savings, { date: '2026-11-05', amount: 50_000, rawName: 'DEPOSIT' });
    expect(await runTransferMatcher(db)).toEqual({ linked: 0, suggested: 2 });
    const suggested = await links();
    expect(suggested.every((l) => l.status === 'suggested')).toBe(true);
    expect((await getTransaction(db, out.id))?.transferLinkId).toBeNull();
    // Unconfirmed: the -$500 still counts as spending and both deposits as income.
    let s = await spending('2026-11-01', '2026-11-30');
    expect(s.spending).toBe(50_000);
    expect(s.income).toBe(100_000);
    // Confirm the first: the other suggestion goes away and the pair is out of reports.
    const pick = suggested.find((l) => l.inTransactionId === a.id)!;
    await confirmLink(db, pick.id);
    expect((await links()).map((l) => l.status)).toEqual(['confirmed']);
    s = await spending('2026-11-01', '2026-11-30');
    expect(s.spending).toBe(0);
    expect(s.income).toBe(50_000);
  });

  it('1.6 re-running the matcher never creates a second link and never re-proposes a rejected pair', async () => {
    const checking = await addAccount({ type: 'checking' });
    const savings = await addAccount({ type: 'savings' });
    const out = await addTxn(checking, { date: '2026-11-03', amount: -100_000 });
    const into = await addTxn(savings, { date: '2026-11-04', amount: 100_000 });
    await runTransferMatcher(db);
    expect(await runTransferMatcher(db)).toEqual({ linked: 0, suggested: 0 });
    const [link] = await links();
    await rejectLink(db, link!.id);
    expect(await runTransferMatcher(db)).toEqual({ linked: 0, suggested: 0 });
    expect(await runTransferMatcher(db)).toEqual({ linked: 0, suggested: 0 });
    const all = await links();
    expect(all.map((l) => l.status)).toEqual(['rejected']);
    expect((await getTransaction(db, out.id))?.transferLinkId).toBeNull();
    expect((await getTransaction(db, into.id))?.transferLinkId).toBeNull();
    // The database itself refuses a second active link for a transaction.
    const other = await addTxn(savings, { date: '2026-11-04', amount: 100_000 });
    await linkManually(db, out.id, into.id);
    await expect(linkManually(db, out.id, other.id)).rejects.toThrow(/already linked/);
    const active = (await links()).filter((l) => l.status === 'auto' || l.status === 'confirmed');
    expect(active).toHaveLength(1);
  });
});

describe('check 2: repeat imports are idempotent, real duplicates are kept', () => {
  it('2.1 a CSV with two identical $5.75 coffees on one day imports two rows', async () => {
    const checking = await addAccount({ type: 'checking' });
    const preview = await previewImport(testEnv, {
      ...file(coffeesCsv, 'coffees.csv'),
      accountId: checking.id,
    });
    expect(preview.counts).toMatchObject({ total: 2, new: 2 });
    expect(preview.rows.map((r) => r.occurrence)).toEqual([1, 2]);
    const result = await commitImport(testEnv, preview.importId);
    expect(result).toMatchObject({ added: 2, matched: 0 });
    const txns = await allTxns();
    expect(txns).toHaveLength(2);
    expect(new Set(txns.map((t) => t.importFingerprint)).size).toBe(2);
    expect(txns.every((t) => t.amount === -575 && t.date === '2026-11-01')).toBe(true);
  });

  it('2.2 importing the same CSV again adds nothing and reports 2 matched, 0 added', async () => {
    const checking = await addAccount({ type: 'checking' });
    const first = await previewImport(testEnv, {
      ...file(coffeesCsv, 'coffees.csv'),
      accountId: checking.id,
    });
    await commitImport(testEnv, first.importId);
    const again = await previewImport(testEnv, {
      ...file(coffeesCsv, 'coffees.csv'),
      accountId: checking.id,
    });
    expect(again.counts).toMatchObject({ total: 2, new: 0, alreadyImported: 2 });
    expect(again.warnings.some((w) => w.includes('imported before'))).toBe(true);
    const result = await commitImport(testEnv, again.importId);
    expect(result).toMatchObject({ added: 0, matched: 2 });
    expect(await allTxns()).toHaveLength(2);
  });

  it('2.2 two previews of one file committed one after the other still add the rows once', async () => {
    const checking = await addAccount({ type: 'checking' });
    const a = await previewImport(testEnv, {
      ...file(coffeesCsv, 'coffees.csv'),
      accountId: checking.id,
    });
    const b = await previewImport(testEnv, {
      ...file(coffeesCsv, 'coffees.csv'),
      accountId: checking.id,
    });
    expect((await commitImport(testEnv, a.importId)).added).toBe(2);
    // b's preview said "new", but the fingerprint index stops the duplicates.
    expect((await commitImport(testEnv, b.importId)).added).toBe(0);
    expect(await allTxns()).toHaveLength(2);
  });

  it('2.3 the same date and amount in a different account is never merged', async () => {
    const checking = await addAccount({ type: 'checking' });
    const card = await addAccount({ type: 'credit_card' });
    const p1 = await previewImport(testEnv, {
      ...file(coffeesCsv, 'coffees.csv'),
      accountId: checking.id,
    });
    await commitImport(testEnv, p1.importId);
    const p2 = await previewImport(testEnv, {
      ...file(coffeesCsv, 'card.csv'),
      accountId: card.id,
    });
    expect(p2.counts.new).toBe(2);
    await commitImport(testEnv, p2.importId);
    const txns = await allTxns();
    expect(txns).toHaveLength(4);
    expect(txns.filter((t) => t.accountId === card.id)).toHaveLength(2);
  });

  const connection = {
    id: 'conn_test',
    connectorId: 'teller',
    institutionName: 'Sample Bank',
    status: 'healthy' as const,
    lastSyncAt: null,
    lastSuccessfulSyncAt: null,
    lastError: null,
    syncCursor: null,
    accountIds: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
  const providerAccount = {
    externalId: 'ext_chk',
    name: 'Everyday Checking',
    institutionName: 'Sample Bank',
    type: 'checking' as const,
    subtype: null,
    currency: 'USD',
    balance: 100_000,
    availableBalance: null,
    creditLimit: null,
    mask: '0001',
  };
  const sync = (transactions: SyncResult['transactions'], removed: string[] = []): SyncResult => ({
    accounts: [providerAccount],
    transactions,
    removedTransactionExternalIds: removed,
    holdings: [],
    activities: [],
    nextCursor: null,
  });
  const ptxn = (fields: Partial<SyncResult['transactions'][number]>) => ({
    externalId: 'T1',
    accountExternalId: 'ext_chk',
    date: '2026-11-01',
    amount: -1_847,
    currency: 'USD',
    originalAmount: null,
    originalCurrency: null,
    rawName: 'CORNER BISTRO',
    merchantName: null,
    pending: false,
    pendingExternalId: null,
    categoryHint: null,
    ...fields,
  });

  it('2.4 a provider transaction with a known externalId updates the row instead of inserting', async () => {
    await insertStatement(db, connectionsTable, connection).run();
    await applySyncResult(db, connection, sync([ptxn({})]));
    const [first] = await allTxns();
    await applySyncResult(
      db,
      connection,
      sync([ptxn({ rawName: 'CORNER BISTRO NYC', amount: -1_900 })]),
    );
    const txns = await allTxns();
    expect(txns).toHaveLength(1);
    expect(txns[0]).toMatchObject({ id: first!.id, amount: -1_900, rawName: 'CORNER BISTRO NYC' });
  });

  it('2.5 a posted transaction replaces its pending version via pendingExternalId', async () => {
    await insertStatement(db, connectionsTable, connection).run();
    await applySyncResult(
      db,
      connection,
      sync([ptxn({ externalId: 'P1', pending: true, amount: -1_847 })]),
    );
    const [pending] = await allTxns();
    expect(pending).toMatchObject({ pending: true, amount: -1_847 });
    await applySyncResult(
      db,
      connection,
      sync(
        [ptxn({ externalId: 'T2', pendingExternalId: 'P1', pending: false, amount: -2_147 })],
        ['P1'],
      ),
    );
    const txns = await allTxns();
    expect(txns).toHaveLength(1);
    expect(txns[0]).toMatchObject({
      id: pending!.id,
      pending: false,
      amount: -2_147,
      externalId: 'T2',
    });
  });
});

describe('check 3: splits balance exactly, write atomically and undo cleanly', () => {
  it('3.1 $100 split into $60 + $40 keeps $100 of spending across two categories', async () => {
    const card = await addAccount({ type: 'credit_card' });
    const t = await addTxn(card, {
      date: '2026-11-02',
      amount: -10_000,
      categoryId: 'cat_shopping',
    });
    const res = await splitTransaction(db, {
      parentTransactionId: t.id,
      idempotencyKey: 'k-31',
      lines: [
        { amount: -6_000, categoryId: 'cat_shopping' },
        { amount: -4_000, categoryId: 'cat_dining' },
      ],
    });
    expect(res.parent.isSplitParent).toBe(true);
    expect(res.children).toHaveLength(2);
    expect((await getTransaction(db, t.id))?.isSplitParent).toBe(true);
    const s = await spending('2026-11-01', '2026-11-30');
    expect(s.spending).toBe(10_000);
    expect(s.byCategory).toEqual({ cat_shopping: 6_000, cat_dining: 4_000 });
  });

  it('3.2 $60 + $50 for a $100 transaction is rejected and nothing is written', async () => {
    const card = await addAccount({ type: 'credit_card' });
    const t = await addTxn(card, {
      date: '2026-11-02',
      amount: -10_000,
      categoryId: 'cat_shopping',
    });
    await expect(
      splitTransaction(db, {
        parentTransactionId: t.id,
        idempotencyKey: 'k-32',
        lines: [
          { amount: -6_000, categoryId: 'cat_shopping' },
          { amount: -5_000, categoryId: 'cat_dining' },
        ],
      }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_split' });
    expect(await allTxns()).toHaveLength(1);
    expect((await getTransaction(db, t.id))?.isSplitParent).toBe(false);
    const keys = await db
      .prepare('SELECT count(*) AS n FROM idempotency_keys')
      .first<{ n: number }>();
    expect(keys?.n).toBe(0);
  });

  it('3.3 two concurrent requests with the same idempotency key create one set of children', async () => {
    const card = await addAccount({ type: 'credit_card' });
    const t = await addTxn(card, {
      date: '2026-11-02',
      amount: -10_000,
      categoryId: 'cat_shopping',
    });
    const req = {
      parentTransactionId: t.id,
      idempotencyKey: 'k-33',
      lines: [
        { amount: -6_000, categoryId: 'cat_shopping' },
        { amount: -4_000, categoryId: 'cat_dining' },
      ],
    };
    const [a, b] = await Promise.all([splitTransaction(db, req), splitTransaction(db, req)]);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    const children = (await allTxns()).filter((x) => x.splitParentId === t.id);
    expect(children).toHaveLength(2);
    // A different key for the same parent is refused too (already split).
    await expect(splitTransaction(db, { ...req, idempotencyKey: 'k-33b' })).rejects.toMatchObject({
      status: 400,
    });
    expect((await allTxns()).filter((x) => x.splitParentId === t.id)).toHaveLength(2);
  });

  it('3.4 undo removes the children and restores the parent in one D1 batch', async () => {
    const card = await addAccount({ type: 'credit_card' });
    const t = await addTxn(card, {
      date: '2026-11-02',
      amount: -10_000,
      categoryId: 'cat_shopping',
    });
    await splitTransaction(db, {
      parentTransactionId: t.id,
      idempotencyKey: 'k-34',
      lines: [
        { amount: -6_000, categoryId: 'cat_shopping' },
        { amount: -4_000, categoryId: 'cat_dining' },
      ],
    });
    const restored = await undoSplit(db, t.id);
    expect(restored.isSplitParent).toBe(false);
    const txns = await allTxns();
    expect(txns).toHaveLength(1);
    expect(txns[0]).toMatchObject({ id: t.id, isSplitParent: false, amount: -10_000 });
    const s = await spending('2026-11-01', '2026-11-30');
    expect(s.byCategory).toEqual({ cat_shopping: 10_000 });
    // It can be split again afterwards, even with the old key.
    const again = await splitTransaction(db, {
      parentTransactionId: t.id,
      idempotencyKey: 'k-34',
      lines: [
        { amount: -5_000, categoryId: 'cat_shopping' },
        { amount: -5_000, categoryId: 'cat_gifts' },
      ],
    });
    expect(again.replayed).toBe(false);
  });

  it('3.5 pending, linked-transfer and already-split rows cannot be split', async () => {
    const checking = await addAccount({ type: 'checking' });
    const savings = await addAccount({ type: 'savings' });
    const lines = [
      { amount: -6_000, categoryId: 'cat_shopping' },
      { amount: -4_000, categoryId: 'cat_dining' },
    ];
    const pending = await addTxn(checking, { date: '2026-11-02', amount: -10_000, pending: true });
    await expect(
      splitTransaction(db, { parentTransactionId: pending.id, idempotencyKey: 'p', lines }),
    ).rejects.toMatchObject({ status: 400 });
    const out = await addTxn(checking, { date: '2026-11-03', amount: -10_000 });
    await addTxn(savings, { date: '2026-11-03', amount: 10_000 });
    await runTransferMatcher(db);
    await expect(
      splitTransaction(db, { parentTransactionId: out.id, idempotencyKey: 'l', lines }),
    ).rejects.toMatchObject({ status: 400 });
    const plain = await addTxn(checking, { date: '2026-11-04', amount: -10_000 });
    await splitTransaction(db, { parentTransactionId: plain.id, idempotencyKey: 's1', lines });
    await expect(
      splitTransaction(db, { parentTransactionId: plain.id, idempotencyKey: 's2', lines }),
    ).rejects.toMatchObject({ status: 400 });
    const child = (await allTxns()).find((x) => x.splitParentId === plain.id)!;
    await expect(
      splitTransaction(db, {
        parentTransactionId: child.id,
        idempotencyKey: 's3',
        lines: [
          { amount: -3_000, categoryId: null },
          { amount: -3_000, categoryId: null },
        ],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('check 4: user edits survive later syncs', () => {
  const connection = {
    id: 'conn_edits',
    connectorId: 'teller',
    institutionName: 'Sample Bank',
    status: 'healthy' as const,
    lastSyncAt: null,
    lastSuccessfulSyncAt: null,
    lastError: null,
    syncCursor: null,
    accountIds: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
  const result = (fields: Partial<SyncResult['transactions'][number]>): SyncResult => ({
    accounts: [
      {
        externalId: 'ext_card',
        name: 'Rewards Card',
        institutionName: 'Sample Bank',
        type: 'credit_card',
        subtype: null,
        currency: 'USD',
        balance: 50_000,
        availableBalance: null,
        creditLimit: 500_000,
        mask: '0002',
      },
    ],
    transactions: [
      {
        externalId: 'T9',
        accountExternalId: 'ext_card',
        date: '2026-11-01',
        amount: -4_500,
        currency: 'USD',
        originalAmount: null,
        originalCurrency: null,
        rawName: 'SQ *GREENLEAF',
        merchantName: null,
        pending: false,
        pendingExternalId: null,
        categoryHint: 'Shopping',
        ...fields,
      },
    ],
    removedTransactionExternalIds: [],
    holdings: [],
    activities: [],
    nextCursor: null,
  });

  beforeEach(async () => {
    await insertStatement(db, connectionsTable, connection).run();
  });

  it('4.1 a user-set category stays after the next sync sends a different category', async () => {
    await applySyncResult(db, connection, result({}));
    const [t] = await allTxns();
    expect(t).toMatchObject({ categoryId: 'cat_shopping', categorySource: 'provider' });
    await editTransaction(db, t!.id, { categoryId: 'cat_gifts' });
    await applySyncResult(db, connection, result({ categoryHint: 'Shopping' }));
    const after = await getTransaction(db, t!.id);
    expect(after).toMatchObject({ categoryId: 'cat_gifts', categorySource: 'user' });
    expect(after?.userEditedFields).toContain('categoryId');
  });

  it('4.2 a renamed transaction keeps its name after sync; untouched fields still update', async () => {
    await applySyncResult(db, connection, result({}));
    const [t] = await allTxns();
    await editTransaction(db, t!.id, { name: 'Greenleaf Florist' });
    await applySyncResult(
      db,
      connection,
      result({ amount: -4_950, rawName: 'SQ *GREENLEAF FLORIST' }),
    );
    const after = await getTransaction(db, t!.id);
    expect(after).toMatchObject({
      name: 'Greenleaf Florist',
      amount: -4_950,
      rawName: 'SQ *GREENLEAF FLORIST',
    });
  });

  it('4.3 rules and AI never overwrite fields listed in userEditedFields', async () => {
    await applySyncResult(db, connection, result({ categoryHint: null }));
    const [t] = await allTxns();
    await editTransaction(db, t!.id, { categoryId: 'cat_gifts', name: 'Greenleaf Florist' });
    const now = '2026-11-02T00:00:00.000Z';
    await insertStatement(db, rulesTable, {
      id: 'rule_greenleaf',
      name: 'Greenleaf is shopping',
      enabled: true,
      priority: 1,
      match: 'all',
      conditions: [{ field: 'rawName', op: 'contains', value: 'GREENLEAF' }],
      actions: [
        { type: 'set_category', categoryId: 'cat_shopping' },
        { type: 'set_name', name: 'Greenleaf Shop' },
        { type: 'add_tag', tagId: 'tag_tax' },
      ],
      source: 'user',
      createdAt: now,
      updatedAt: now,
    }).run();
    await runRules(db);
    // The AI wants Shopping too, with high confidence.
    const ai = fakeAi({ categorize: { [t!.id]: { category: 'Shopping', confidence: 0.97 } } });
    await runCategorization(testEnv, { all: true }, ai.deps);
    const after = await getTransaction(db, t!.id);
    expect(after).toMatchObject({
      categoryId: 'cat_gifts',
      name: 'Greenleaf Florist',
      categorySource: 'user',
    });
    // Fields the user didn't touch still follow the rule.
    expect(after?.tagIds).toEqual(['tag_tax']);
  });
});

describe('check 5: refund and investment-contribution policies are explicit', () => {
  it('5.1 a $30 refund on a $100 category purchase reports $70 in that category', async () => {
    const card = await addAccount({ type: 'credit_card' });
    await addTxn(card, { date: '2026-11-02', amount: -10_000, categoryId: 'cat_shopping' });
    await addTxn(card, {
      date: '2026-11-09',
      amount: 3_000,
      categoryId: 'cat_shopping',
      rawName: 'REFUND',
    });
    const s = await spending('2026-11-01', '2026-11-30');
    expect(s.byCategory.cat_shopping).toBe(7_000);
    expect(s.spending).toBe(7_000);
    expect(s.income).toBe(0);
  });

  it('5.2 a refund in a later month reduces that month and can make the category negative', async () => {
    const card = await addAccount({ type: 'credit_card' });
    await addTxn(card, { date: '2026-10-20', amount: -8_000, categoryId: 'cat_shopping' });
    await addTxn(card, {
      date: '2026-11-03',
      amount: 2_450,
      categoryId: 'cat_shopping',
      rawName: 'REFUND',
    });
    expect((await spending('2026-10-01', '2026-10-31')).byCategory.cat_shopping).toBe(8_000);
    const nov = await spending('2026-11-01', '2026-11-30');
    expect(nov.byCategory.cat_shopping).toBe(-2_450);
    expect(nov.spending).toBe(-2_450);
    // With the zero floor policy the category stops at 0.
    const floored = await spending('2026-11-01', '2026-11-30', {
      ...DEFAULT_MONEY_POLICIES,
      categoryFloor: 'zero',
    });
    expect(floored.byCategory.cat_shopping).toBe(0);
    // Counted as income instead, when the policy says so.
    const asIncome = await spending('2026-11-01', '2026-11-30', {
      ...DEFAULT_MONEY_POLICIES,
      refunds: 'count_as_income',
    });
    expect(asIncome.spending).toBe(0);
    expect(asIncome.income).toBe(2_450);
  });

  it('5.3 a $500 brokerage contribution is excluded by default and counted when the policy says so', async () => {
    const checking = await addAccount({ type: 'checking' });
    const brokerage = await addAccount({ type: 'brokerage' });
    await addTxn(checking, {
      date: '2026-11-05',
      amount: -50_000,
      rawName: 'TRANSFER TO BROKERAGE',
    });
    await addTxn(brokerage, { date: '2026-11-06', amount: 50_000, rawName: 'DEPOSIT' });
    await runTransferMatcher(db);
    const [link] = await links();
    expect(link).toMatchObject({ kind: 'investment_contribution', status: 'auto' });
    const byDefault = await spending('2026-11-01', '2026-11-30');
    expect(byDefault.spending).toBe(0);
    expect(byDefault.income).toBe(0);
    const counted = await spending('2026-11-01', '2026-11-30', {
      ...DEFAULT_MONEY_POLICIES,
      investmentContributions: 'count',
    });
    expect(counted.spending).toBe(50_000);
    expect(counted.income).toBe(0);
  });

  it('5.4 loan principal is excluded and loan interest counts as spending', async () => {
    const checking = await addAccount({ type: 'checking' });
    const t = await addTxn(checking, {
      date: '2026-11-01',
      amount: -45_218,
      rawName: 'AUTO LOAN PMT',
    });
    await splitTransaction(db, {
      parentTransactionId: t.id,
      idempotencyKey: 'loan-1',
      lines: [
        { amount: -38_940, categoryId: 'cat_loan_payment', kind: 'loan_payment' },
        { amount: -6_278, categoryId: 'cat_loan_interest' },
      ],
    });
    const s = await spending('2026-11-01', '2026-11-30');
    expect(s.spending).toBe(6_278);
    expect(s.byCategory).toEqual({ cat_loan_interest: 6_278 });
    const counted = await spending('2026-11-01', '2026-11-30', {
      ...DEFAULT_MONEY_POLICIES,
      loanPrincipal: 'count',
    });
    expect(counted.spending).toBe(45_218);
  });

  it('5.5 every policy value changes the totals as described', async () => {
    const checking = await addAccount({ type: 'checking' });
    const savings = await addAccount({ type: 'savings' });
    const card = await addAccount({ type: 'credit_card' });
    await addTxn(card, { date: '2026-11-02', amount: -10_000, categoryId: 'cat_shopping' });
    await addTxn(checking, { date: '2026-11-20', amount: -10_000, rawName: 'CARD PAYMENT' });
    await addTxn(card, { date: '2026-11-20', amount: 10_000, rawName: 'PAYMENT - THANK YOU' });
    await addTxn(checking, { date: '2026-11-10', amount: -30_000, rawName: 'TRANSFER TO SAVINGS' });
    await addTxn(savings, {
      date: '2026-11-10',
      amount: 30_000,
      rawName: 'TRANSFER FROM CHECKING',
    });
    await addTxn(checking, {
      date: '2026-11-25',
      amount: -2_000,
      categoryId: 'cat_dining',
      pending: true,
    });
    await runTransferMatcher(db);
    const run = (p: Partial<MoneyPolicies>) =>
      spending('2026-11-01', '2026-11-30', { ...DEFAULT_MONEY_POLICIES, ...p });
    expect((await run({})).spending).toBe(12_000);
    expect((await run({ cardPayments: 'count' })).spending).toBe(22_000);
    expect((await run({ transfers: 'count' })).spending).toBe(42_000);
    expect((await run({ pendingTransactions: 'exclude' })).spending).toBe(10_000);
    // Settings changes are read back from D1 by the API (see api.test.ts).
  });
});
