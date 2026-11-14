import {
  buildSplitChildren,
  validateSplit,
  type Id,
  type SplitRequest,
  type Transaction,
} from '@manaclaude/shared';
import { insertStatement, selectAll } from '../db/table';
import { transactionsTable } from '../db/tables';
import { ApiError, badRequest, notFound } from '../util/errors';
import { newId, nowIso } from '../util/ids';
import { getTransaction } from './transactions';

export interface SplitResult {
  parent: Transaction;
  children: Transaction[];
  /** True when this request repeated an earlier one with the same idempotency key. */
  replayed: boolean;
}

async function currentSplit(db: D1Database, parentId: Id): Promise<SplitResult | null> {
  const parent = await getTransaction(db, parentId);
  if (!parent || !parent.isSplitParent) return null;
  const children = await selectAll(
    db,
    transactionsTable,
    'split_parent_id = ?',
    [parentId],
    'created_at, id',
  );
  return { parent, children, replayed: true };
}

/**
 * Splits one transaction (research/sure/rea.md SURE-002 and check 3). The
 * lines must add up exactly; validation uses validateSplit from the shared
 * package. The idempotency key, a per-parent split lock, the parent update and
 * the children are written in one D1 batch, which is atomic: a double tap or a
 * concurrent request fails on the unique key and gets the first result back.
 */
export async function splitTransaction(db: D1Database, req: SplitRequest): Promise<SplitResult> {
  if (!req.idempotencyKey) throw badRequest('An idempotency key is required.');
  const seen = await db
    .prepare('SELECT subject_id FROM idempotency_keys WHERE key = ?')
    .bind(req.idempotencyKey)
    .first<{ subject_id: string }>();
  if (seen) {
    const existing = await currentSplit(db, seen.subject_id);
    if (existing) return existing;
  }
  const parent = await getTransaction(db, req.parentTransactionId);
  if (!parent) throw notFound('Transaction not found.');
  const check = validateSplit(parent, req.lines);
  if (!check.ok) throw badRequest(check.error, 'invalid_split');
  const now = nowIso();
  const { parent: updated, children } = buildSplitChildren(
    parent,
    req.lines,
    () => newId('txn'),
    now,
  );
  try {
    await db.batch([
      db
        .prepare(
          'INSERT INTO idempotency_keys (key, scope, subject_id, created_at) VALUES (?, ?, ?, ?)',
        )
        .bind(req.idempotencyKey, 'split', parent.id, now),
      db
        .prepare(
          `INSERT INTO split_locks (parent_id, created_at) VALUES (?1,
            CASE WHEN EXISTS (SELECT 1 FROM transactions WHERE id = ?1 AND is_split_parent = 0)
            THEN ?2 ELSE NULL END)`,
        )
        .bind(parent.id, now),
      db
        .prepare(
          'UPDATE transactions SET is_split_parent = 1, updated_at = ? WHERE id = ? AND is_split_parent = 0',
        )
        .bind(now, parent.id),
      ...children.map((c) => insertStatement(db, transactionsTable, c)),
    ]);
  } catch {
    // Another request with this key (or another split of this parent) won the race.
    const existing = await currentSplit(db, parent.id);
    if (existing) return existing;
    throw new ApiError(
      409,
      'split_conflict',
      'This transaction is being split by another request.',
    );
  }
  return { parent: updated, children, replayed: false };
}

/** Undo: removes the children and restores the parent in one D1 batch. */
export async function undoSplit(db: D1Database, parentId: Id): Promise<Transaction> {
  const parent = await getTransaction(db, parentId);
  if (!parent) throw notFound('Transaction not found.');
  if (!parent.isSplitParent) throw badRequest('This transaction is not split.');
  const linked = await db
    .prepare(
      'SELECT count(*) AS n FROM transactions WHERE split_parent_id = ? AND transfer_link_id IS NOT NULL',
    )
    .bind(parentId)
    .first<{ n: number }>();
  if ((linked?.n ?? 0) > 0) throw badRequest('Unlink the split lines from their transfers first.');
  const now = nowIso();
  await db.batch([
    db.prepare('DELETE FROM transactions WHERE split_parent_id = ?').bind(parentId),
    db
      .prepare('UPDATE transactions SET is_split_parent = 0, updated_at = ? WHERE id = ?')
      .bind(now, parentId),
    db.prepare('DELETE FROM split_locks WHERE parent_id = ?').bind(parentId),
    db
      .prepare("DELETE FROM idempotency_keys WHERE scope = 'split' AND subject_id = ?")
      .bind(parentId),
  ]);
  return { ...parent, isSplitParent: false, updatedAt: now };
}
