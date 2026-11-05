import {
  fnv1a64,
  type Id,
  type Rule,
  type Transaction,
  type UserEditableField,
} from '@manaclaude/shared';
import { insertStatement, updateStatement } from '../db/table';
import { rulesTable, transactionsTable } from '../db/tables';
import { cleanMerchantName, merchantKey } from '../ai/merchant';
import { badRequest, notFound } from '../util/errors';
import { newId, nowIso } from '../util/ids';
import { getTransaction } from './transactions';

export interface TransactionPatch {
  name?: string;
  date?: string;
  amount?: number;
  categoryId?: string | null;
  merchantId?: string | null;
  kind?: Transaction['kind'];
  notes?: string | null;
  tagIds?: string[];
  excluded?: boolean;
  reviewed?: boolean;
}

const EDITABLE: UserEditableField[] = [
  'name',
  'date',
  'amount',
  'categoryId',
  'merchantId',
  'kind',
  'notes',
  'tagIds',
  'excluded',
];

/** Learned rules sort after the user's own rules. */
export const LEARNED_RULE_PRIORITY = 500;

/**
 * Saves a user's edit. Every changed field is added to userEditedFields, so
 * sync, rules and AI never change it again (check 4). A category correction
 * also teaches the categorizer: it stores an example and a learned rule for
 * that merchant.
 */
export async function editTransaction(
  db: D1Database,
  id: Id,
  patch: TransactionPatch,
  options: { learn?: boolean } = {},
): Promise<Transaction> {
  const txn = await getTransaction(db, id);
  if (!txn) throw notFound('Transaction not found.');
  if (patch.amount !== undefined) {
    if (!Number.isSafeInteger(patch.amount)) throw badRequest('Amount must be whole minor units.');
    if (txn.isSplitParent || txn.splitParentId) throw badRequest('Undo the split before changing the amount.');
    if (txn.transferLinkId) throw badRequest('Unlink the transfer before changing the amount.');
  }
  const now = nowIso();
  const next: Transaction = { ...txn, userEditedFields: [...txn.userEditedFields] };
  const changes: Partial<Transaction> = {};
  for (const field of EDITABLE) {
    if (!(field in patch)) continue;
    const value = (patch as Record<string, unknown>)[field];
    if (JSON.stringify(value) === JSON.stringify(txn[field])) continue;
    (changes as Record<string, unknown>)[field] = value;
    if (!next.userEditedFields.includes(field)) next.userEditedFields.push(field);
  }
  if ('categoryId' in changes) {
    changes.categorySource = 'user';
    changes.aiCategoryConfidence = null;
  }
  if ('amount' in changes && txn.originalCurrency === txn.currency) {
    changes.originalAmount = changes.amount;
  }
  if (patch.reviewed !== undefined && patch.reviewed !== txn.reviewed) {
    changes.reviewed = patch.reviewed;
    changes.reviewedAt = patch.reviewed ? now : null;
  }
  if (Object.keys(changes).length === 0) return txn;
  changes.userEditedFields = next.userEditedFields;
  changes.updatedAt = now;
  const statements = [updateStatement(db, transactionsTable, { id }, changes)];
  const corrected =
    'categoryId' in changes && changes.categoryId && txn.categorySource !== 'user' && options.learn !== false;
  if (corrected) statements.push(...learnStatements(db, txn, changes.categoryId!, now));
  await db.batch(statements);
  return { ...txn, ...changes };
}

/** Example + learned rule for a category correction. The newest correction for a merchant wins. */
function learnStatements(db: D1Database, txn: Transaction, categoryId: Id, now: string): D1PreparedStatement[] {
  const key = merchantKey(txn.rawName);
  if (!key) return [];
  const rule: Rule = {
    id: `rule_learned_${fnv1a64(key)}`,
    name: `${cleanMerchantName(txn.rawName)} (learned)`,
    enabled: true,
    priority: LEARNED_RULE_PRIORITY,
    match: 'all',
    conditions: [{ field: 'rawName', op: 'contains', value: cleanMerchantName(txn.rawName) }],
    actions: [{ type: 'set_category', categoryId }],
    source: 'learned',
    createdAt: now,
    updatedAt: now,
  };
  return [
    db
      .prepare(
        'INSERT INTO ai_examples (id, normalized_name, raw_name, amount, currency, category_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(newId('ex'), key, txn.rawName, txn.amount, txn.currency, categoryId, now),
    insertStatement(db, rulesTable, rule, 'upsert'),
  ];
}
