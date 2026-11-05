import type { Account, CurrencyCode, Id, LocalDate, Transaction } from '@manaclaude/shared';
import { insertStatement, selectAll, selectOne } from '../db/table';
import { accountsTable, transactionsTable, transferLinksTable } from '../db/tables';
import { linkFromCandidate } from './matcher';
import { badRequest } from '../util/errors';
import { newId, nowIso } from '../util/ids';
import { makeTransaction } from './transactions';

/** The quick-add target for a currency, created on first use ("Cash (INR)"). */
export async function defaultCashAccount(db: D1Database, currency: CurrencyCode): Promise<Account> {
  const existing =
    (await selectOne(db, accountsTable, "type = 'cash' AND currency = ? AND is_default_cash = 1", [currency])) ??
    (await selectOne(db, accountsTable, "type = 'cash' AND currency = ?", [currency]));
  if (existing) return existing;
  return createCashAccount(db, { currency, name: `Cash (${currency})`, isDefault: true });
}

export async function createCashAccount(
  db: D1Database,
  input: { currency: CurrencyCode; name: string; balance?: number; isDefault?: boolean },
): Promise<Account> {
  if (!/^[A-Z]{3}$/.test(input.currency)) throw badRequest('Currency must be a 3-letter code.');
  const now = nowIso();
  const account: Account = {
    id: newId('acc'),
    name: input.name,
    institutionName: null,
    type: 'cash',
    subtype: null,
    currency: input.currency,
    balance: input.balance ?? 0,
    balanceAsOf: now,
    availableBalance: null,
    creditLimit: null,
    mask: null,
    connectionId: null,
    externalId: null,
    includeInNetWorth: true,
    hidden: false,
    isDefaultCash: input.isDefault ?? false,
    interestRate: null,
    openedOn: now.slice(0, 10),
    createdAt: now,
    updatedAt: now,
  };
  await insertStatement(db, accountsTable, account).run();
  return account;
}

export interface CashEntry {
  /** Signed minor units: negative for spending (the usual case). */
  amount: number;
  currency: CurrencyCode;
  categoryId?: Id | null;
  name?: string;
  date: LocalDate;
  notes?: string | null;
  accountId?: Id;
}

/** Fast cash entry. The account balance moves with it. */
export async function addCashTransaction(db: D1Database, entry: CashEntry): Promise<Transaction> {
  if (!Number.isSafeInteger(entry.amount) || entry.amount === 0) {
    throw badRequest('Amount must be a non-zero whole number of minor units.');
  }
  const account = entry.accountId
    ? await selectOne(db, accountsTable, "id = ? AND type = 'cash'", [entry.accountId])
    : await defaultCashAccount(db, entry.currency);
  if (!account) throw badRequest('That is not a cash account.');
  if (account.currency !== entry.currency) throw badRequest('The cash account uses another currency.');
  const now = nowIso();
  const txn = makeTransaction(
    {
      accountId: account.id,
      date: entry.date,
      amount: entry.amount,
      currency: entry.currency,
      rawName: entry.name?.trim() || 'Cash',
      categoryId: entry.categoryId ?? null,
      categorySource: entry.categoryId ? 'user' : null,
      notes: entry.notes ?? null,
      source: 'manual',
      reviewed: true,
      reviewedAt: now,
      userEditedFields: entry.categoryId ? ['categoryId'] : [],
    },
    now,
  );
  await db.batch([
    insertStatement(db, transactionsTable, txn),
    db
      .prepare('UPDATE accounts SET balance = balance + ?, balance_as_of = ?, updated_at = ? WHERE id = ?')
      .bind(entry.amount, now, now, account.id),
  ]);
  return txn;
}

const ATM = /\b(atm|cash withdrawal|cash wdl|atw|nwd)\b/i;

/**
 * ATM withdrawals become transfers into cash: for each unlinked ATM debit
 * outside a cash account, add the matching deposit to the default cash account
 * in that currency (once; keyed by the withdrawal id) and link the pair.
 */
export async function recordAtmWithdrawals(db: D1Database, transactions?: Transaction[]): Promise<number> {
  const candidates = (
    transactions ??
    (await selectAll(db, transactionsTable, 'amount < 0 AND transfer_link_id IS NULL AND is_split_parent = 0 AND pending = 0'))
  ).filter((t) => t.amount < 0 && !t.transferLinkId && !t.pending && !t.isSplitParent && ATM.test(t.rawName));
  if (candidates.length === 0) return 0;
  const accounts = new Map((await selectAll(db, accountsTable)).map((a) => [a.id, a]));
  let created = 0;
  for (const out of candidates) {
    const source = accounts.get(out.accountId);
    if (!source || source.type === 'cash' || source.type === 'credit_card') continue;
    const cash = await defaultCashAccount(db, out.currency);
    accounts.set(cash.id, cash);
    // Skip when the cash side was entered by hand already (same amount within 5 days).
    const manual = await db
      .prepare(
        'SELECT id FROM transactions WHERE account_id = ? AND amount = ? AND transfer_link_id IS NULL AND abs(julianday(date) - julianday(?)) <= 5 LIMIT 1',
      )
      .bind(cash.id, -out.amount, out.date)
      .first();
    if (manual) continue;
    const now = nowIso();
    const deposit = makeTransaction(
      {
        accountId: cash.id,
        date: out.date,
        amount: -out.amount,
        currency: out.currency,
        rawName: 'ATM cash',
        kind: 'transfer',
        source: 'manual',
        externalId: `atm:${out.id}`,
      },
      now,
    );
    const inserted = await insertStatement(db, transactionsTable, deposit, 'ignore').run();
    if ((inserted.meta.changes ?? 0) === 0) continue;
    // The deposit exists because of this withdrawal, so link the pair right away.
    const link = linkFromCandidate(
      { out, in: deposit, kind: 'atm_withdrawal', score: 1, impliedRate: 1 },
      'auto',
      'matcher',
      now,
    );
    await db.batch([
      db
        .prepare('UPDATE accounts SET balance = balance + ?, updated_at = ? WHERE id = ?')
        .bind(-out.amount, now, cash.id),
      insertStatement(db, transferLinksTable, link),
      db
        .prepare('UPDATE transactions SET transfer_link_id = ?, updated_at = ? WHERE id IN (?, ?) AND transfer_link_id IS NULL')
        .bind(link.id, now, out.id, deposit.id),
    ]);
    created += 1;
  }
  return created;
}
