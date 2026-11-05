import type { Account, CurrencyCode, Id, LocalDate, Transaction } from '@manaclaude/shared';
import { bulkInsertSpecs, runSpecs } from '../db/bulk';
import { insertStatement, selectAll, selectOne } from '../db/table';
import { accountsTable, transactionsTable, transferLinksTable } from '../db/tables';
import { linkFromCandidate, linkIdsSpec } from './matcher';
import { badRequest } from '../util/errors';
import { newId, nowIso } from '../util/ids';
import { makeTransaction } from './transactions';

/** The quick-add target for a currency, created on first use ("Cash (INR)"). */
export async function defaultCashAccount(db: D1Database, currency: CurrencyCode): Promise<Account> {
  const existing =
    (await selectOne(db, accountsTable, "type = 'cash' AND currency = ? AND is_default_cash = 1", [
      currency,
    ])) ?? (await selectOne(db, accountsTable, "type = 'cash' AND currency = ?", [currency]));
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
  if (account.currency !== entry.currency)
    throw badRequest('The cash account uses another currency.');
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
      .prepare(
        'UPDATE accounts SET balance = balance + ?, balance_as_of = ?, updated_at = ? WHERE id = ?',
      )
      .bind(entry.amount, now, now, account.id),
  ]);
  return txn;
}

const ATM = /\b(atm|cash withdrawal|cash wdl|atw|nwd)\b/i;

/**
 * ATM withdrawals become transfers into cash: for each unlinked ATM debit
 * outside a cash account, add the matching deposit to the default cash account
 * in that currency (once; keyed by the withdrawal id) and link the pair.
 *
 * About nine D1 queries however many withdrawals there are (two years of
 * history can hold dozens), so it fits the Free plan's per-invocation limit:
 * the candidates, the accounts, one check for cash entries typed in by hand,
 * then multi-row writes for the deposits, the balances, the links and the
 * transactions' link ids.
 */
export async function recordAtmWithdrawals(
  db: D1Database,
  transactions?: Transaction[],
  opts: { accountIds?: readonly Id[] } = {},
): Promise<number> {
  let pool = transactions;
  if (!pool) {
    const scoped = opts.accountIds && opts.accountIds.length > 0;
    if (opts.accountIds && !scoped) return 0;
    pool = await selectAll(
      db,
      transactionsTable,
      `amount < 0 AND transfer_link_id IS NULL AND is_split_parent = 0 AND pending = 0${
        scoped ? ' AND account_id IN (SELECT value FROM json_each(?))' : ''
      }`,
      scoped ? [JSON.stringify(opts.accountIds)] : [],
    );
  }
  const candidates = pool.filter(
    (t) =>
      t.amount < 0 && !t.transferLinkId && !t.pending && !t.isSplitParent && ATM.test(t.rawName),
  );
  if (candidates.length === 0) return 0;
  const accounts = new Map((await selectAll(db, accountsTable)).map((a) => [a.id, a]));
  const eligible = candidates.filter((out) => {
    const source = accounts.get(out.accountId);
    return source && source.type !== 'cash' && source.type !== 'credit_card';
  });
  if (eligible.length === 0) return 0;

  // One default cash account per currency (created on first use).
  const cashByCurrency = new Map<CurrencyCode, Account>();
  for (const currency of new Set(eligible.map((t) => t.currency))) {
    const all = [...accounts.values()].filter((a) => a.type === 'cash' && a.currency === currency);
    const cash =
      all.find((a) => a.isDefaultCash) ??
      all[0] ??
      (await createCashAccount(db, { currency, name: `Cash (${currency})`, isDefault: true }));
    cashByCurrency.set(currency, cash);
  }

  // Skip a withdrawal when its cash side was typed in by hand (same amount within 5 days), each hand entry used once.
  const cashIds = [...cashByCurrency.values()].map((a) => a.id);
  const handEntries = await selectAll(
    db,
    transactionsTable,
    'account_id IN (SELECT value FROM json_each(?)) AND transfer_link_id IS NULL AND amount > 0',
    [JSON.stringify(cashIds)],
  );
  const used = new Set<Id>();
  const days = (a: string, b: string) =>
    Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
  const now = nowIso();
  const pairs: { out: Transaction; deposit: Transaction; cash: Account }[] = [];
  for (const out of eligible) {
    const cash = cashByCurrency.get(out.currency)!;
    const manual = handEntries.find(
      (h) =>
        !used.has(h.id) &&
        h.accountId === cash.id &&
        h.amount === -out.amount &&
        h.externalId !== `atm:${out.id}` &&
        days(h.date, out.date) <= 5,
    );
    if (manual) {
      used.add(manual.id);
      continue;
    }
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
    pairs.push({ out, deposit, cash });
  }
  if (pairs.length === 0) return 0;

  // Insert the deposits; the unique (account, source, external id) index skips ones made before.
  await runSpecs(
    db,
    bulkInsertSpecs(
      transactionsTable,
      pairs.map((p) => p.deposit),
      'ignore',
    ),
  );
  const inserted = await db
    .prepare('SELECT id FROM transactions WHERE id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(pairs.map((p) => p.deposit.id)))
    .all<{ id: string }>();
  const fresh = new Set(inserted.results.map((r) => r.id));
  const made = pairs.filter((p) => fresh.has(p.deposit.id));
  if (made.length === 0) return 0;

  // The deposit exists because of this withdrawal, so link the pair right away.
  const links = made.map((p) =>
    linkFromCandidate(
      { out: p.out, in: p.deposit, kind: 'atm_withdrawal', score: 1, impliedRate: 1 },
      'auto',
      'matcher',
      now,
    ),
  );
  const byCash = new Map<Id, number>();
  for (const p of made) byCash.set(p.cash.id, (byCash.get(p.cash.id) ?? 0) - p.out.amount);
  await runSpecs(db, [
    ...[...byCash.entries()].map(([id, delta]) => ({
      sql: 'UPDATE accounts SET balance = balance + ?, updated_at = ? WHERE id = ?',
      params: [delta, now, id],
      rows: 1,
    })),
    ...bulkInsertSpecs(transferLinksTable, links, 'ignore'),
    linkIdsSpec(links, now),
  ]);
  return links.length;
}
