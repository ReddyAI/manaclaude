import { applyRules, type Id, type Transaction } from '@manaclaude/shared';
import { batchInChunks, selectAll, updateStatement } from '../db/table';
import { rulesTable, transactionsTable } from '../db/tables';
import { nowIso } from '../util/ids';

/** Fields rules may change (never anything in userEditedFields; see applyRules). */
function changedFields(before: Transaction, after: Transaction): Partial<Transaction> {
  const out: Partial<Transaction> = {};
  const keys: (keyof Transaction)[] = [
    'categoryId',
    'categorySource',
    'aiCategoryConfidence',
    'name',
    'kind',
    'tagIds',
    'reviewed',
    'excluded',
  ];
  for (const k of keys) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      (out as Record<string, unknown>)[k] = after[k];
    }
  }
  return out;
}

/** Applies every enabled rule to the given transactions and saves the changes. */
export async function runRules(db: D1Database, transactionIds?: Id[]): Promise<number> {
  const rules = await selectAll(db, rulesTable, 'enabled = 1');
  if (rules.length === 0) return 0;
  let txns: Transaction[];
  if (transactionIds) {
    if (transactionIds.length === 0) return 0;
    txns = [];
    for (let i = 0; i < transactionIds.length; i += 90) {
      const chunk = transactionIds.slice(i, i + 90);
      txns.push(
        ...(await selectAll(
          db,
          transactionsTable,
          `id IN (${chunk.map(() => '?').join(',')})`,
          chunk,
        )),
      );
    }
  } else {
    txns = await selectAll(db, transactionsTable, 'is_split_parent = 0');
  }
  const now = nowIso();
  const statements: D1PreparedStatement[] = [];
  for (const t of txns) {
    const { transaction } = applyRules(t, rules);
    const changes = changedFields(t, transaction);
    if (Object.keys(changes).length === 0) continue;
    statements.push(
      updateStatement(db, transactionsTable, { id: t.id }, { ...changes, updatedAt: now }),
    );
  }
  await batchInChunks(db, statements);
  return statements.length;
}
