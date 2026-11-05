import type { Id, Transaction, TransactionSource } from '@manaclaude/shared';
import { selectAll, selectOne } from '../db/table';
import { transactionsTable } from '../db/tables';
import { newId, nowIso } from '../util/ids';

/** A new transaction with every field set; override what you know. */
export function makeTransaction(
  fields: Pick<Transaction, 'accountId' | 'date' | 'amount' | 'currency'> &
    Partial<Transaction> & { source: TransactionSource },
  now = nowIso(),
): Transaction {
  const rawName = fields.rawName ?? fields.name ?? '';
  return {
    id: newId('txn'),
    originalAmount: fields.amount,
    originalCurrency: fields.currency,
    name: rawName,
    rawName,
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
    connectionId: null,
    externalId: null,
    pendingExternalId: null,
    importId: null,
    importFingerprint: null,
    createdAt: now,
    updatedAt: now,
    ...fields,
  };
}

export function getTransaction(db: D1Database, id: Id): Promise<Transaction | null> {
  return selectOne(db, transactionsTable, 'id = ?', [id]);
}

export interface TransactionQuery {
  from?: string;
  to?: string;
  accountId?: string;
  categoryId?: string;
  search?: string;
  /** Include split parents (hidden from lists by default; their children show instead). */
  includeSplitParents?: boolean;
  limit?: number;
  offset?: number;
}

export function listTransactions(db: D1Database, q: TransactionQuery = {}): Promise<Transaction[]> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q.from) {
    where.push('date >= ?');
    params.push(q.from);
  }
  if (q.to) {
    where.push('date <= ?');
    params.push(q.to);
  }
  if (q.accountId) {
    where.push('account_id = ?');
    params.push(q.accountId);
  }
  if (q.categoryId) {
    where.push('category_id = ?');
    params.push(q.categoryId);
  }
  if (q.search) {
    where.push('(name LIKE ? OR raw_name LIKE ? OR notes LIKE ?)');
    const like = `%${q.search.replace(/[%_]/g, '')}%`;
    params.push(like, like, like);
  }
  if (!q.includeSplitParents) where.push('is_split_parent = 0');
  const limit = Math.min(Math.max(q.limit ?? 500, 1), 5000);
  const offset = Math.max(q.offset ?? 0, 0);
  return selectAll(
    db,
    transactionsTable,
    where.join(' AND '),
    params,
    `date DESC, created_at DESC LIMIT ${limit} OFFSET ${offset}`,
  );
}

/** Everything, for reports. Split parents included so reportTreatment can skip them. */
export function allTransactions(db: D1Database, from?: string, to?: string): Promise<Transaction[]> {
  if (from && to) return selectAll(db, transactionsTable, 'date >= ? AND date <= ?', [from, to]);
  return selectAll(db, transactionsTable);
}
