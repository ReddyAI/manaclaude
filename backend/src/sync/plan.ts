import {
  mergeRespectingUserEdits,
  type Account,
  type Category,
  type Connection,
  type Id,
  type ProviderTransaction,
  type SyncResult,
  type Transaction,
} from '@manaclaude/shared';
import { makeTransaction } from '../services/transactions';

/**
 * What a sync should do to the transactions table. Session D owns the real
 * version of this (pure functions in connectors/src/sync/). This planner
 * follows the same contract so the backend works before D's code lands:
 * - dedupe by (account, provider id)
 * - a posted transaction replaces its pending version (same row id, so links,
 *   receipts and edits stay attached)
 * - fields in userEditedFields are never changed
 */
export interface SyncPlan {
  inserts: Transaction[];
  updates: { id: Id; before: Transaction; after: Transaction }[];
  removals: Id[];
  /** Provider rows whose account isn't known yet. */
  unknownAccounts: string[];
}

export interface SyncPlanInput {
  connection: Connection;
  result: SyncResult;
  /** Accounts of this connection, keyed by provider account id. */
  accountsByExternalId: ReadonlyMap<string, Account>;
  /** Existing connector transactions of those accounts. */
  existing: readonly Transaction[];
  categories: readonly Category[];
  now: string;
}

function providerFields(p: ProviderTransaction, categoryId: Id | null): Partial<Transaction> {
  const fields: Partial<Transaction> = {
    date: p.date,
    amount: p.amount,
    currency: p.currency,
    originalAmount: p.originalAmount ?? p.amount,
    originalCurrency: p.originalCurrency ?? p.currency,
    rawName: p.rawName,
    pending: p.pending,
    externalId: p.externalId,
    pendingExternalId: p.pendingExternalId,
  };
  if (categoryId) {
    fields.categoryId = categoryId;
    fields.categorySource = 'provider';
  }
  return fields;
}

export function planSync(input: SyncPlanInput): SyncPlan {
  const { result, accountsByExternalId, existing, now } = input;
  const byExternal = new Map<string, Transaction>();
  for (const t of existing) {
    if (t.externalId) byExternal.set(`${t.accountId}|${t.externalId}`, t);
  }
  const categoryByName = new Map(input.categories.map((c) => [c.name.toLowerCase(), c.id]));
  const plan: SyncPlan = { inserts: [], updates: [], removals: [], unknownAccounts: [] };
  const touched = new Set<Id>();
  for (const p of result.transactions) {
    const account = accountsByExternalId.get(p.accountExternalId);
    if (!account) {
      if (!plan.unknownAccounts.includes(p.accountExternalId))
        plan.unknownAccounts.push(p.accountExternalId);
      continue;
    }
    const hintCategory = p.categoryHint
      ? (categoryByName.get(p.categoryHint.toLowerCase()) ?? null)
      : null;
    const current =
      byExternal.get(`${account.id}|${p.externalId}`) ??
      (p.pendingExternalId ? byExternal.get(`${account.id}|${p.pendingExternalId}`) : undefined);
    if (current) {
      if (touched.has(current.id)) continue;
      touched.add(current.id);
      const fields = providerFields(p, null);
      // A provider category only fills an empty category; it never replaces one.
      if (hintCategory && !current.categoryId) {
        fields.categoryId = hintCategory;
        fields.categorySource = 'provider';
      }
      if (current.rawName === current.name && p.rawName !== current.rawName) {
        fields.name = p.merchantName ?? p.rawName;
      }
      const { transaction } = mergeRespectingUserEdits(current, fields);
      const changed =
        JSON.stringify({ ...transaction, updatedAt: '' }) !==
        JSON.stringify({ ...current, updatedAt: '' });
      if (changed)
        plan.updates.push({
          id: current.id,
          before: current,
          after: { ...transaction, updatedAt: now },
        });
      byExternal.set(`${account.id}|${p.externalId}`, transaction);
      continue;
    }
    const txn = makeTransaction(
      {
        accountId: account.id,
        currency: p.currency,
        date: p.date,
        amount: p.amount,
        rawName: p.rawName,
        name: p.merchantName ?? p.rawName,
        source: 'connector',
        connectionId: input.connection.id,
        ...providerFields(p, hintCategory),
      },
      now,
    );
    plan.inserts.push(txn);
    byExternal.set(`${account.id}|${p.externalId}`, txn);
  }
  const removed = new Set(result.removedTransactionExternalIds);
  for (const t of existing) {
    if (t.externalId && removed.has(t.externalId) && !touched.has(t.id) && !t.isSplitParent) {
      plan.removals.push(t.id);
    }
  }
  return plan;
}
