import {
  mergeRespectingUserEdits,
  type Connection,
  type Id,
  type ProviderTransaction,
  type SyncResult,
  type Transaction,
} from '@manaclaude/shared';
import { makeTransaction } from '../services/transactions';

/**
 * Stand-in for session D's planTransactionSync (connectors/src/sync/). Same
 * output shape, so applySyncResult can switch to D's function with a one-line
 * change when it lands on main:
 * - dedupe by (account, provider id)
 * - a posted transaction replaces its pending version (same row id, so links,
 *   receipts and edits stay attached)
 * - fields in userEditedFields are never changed
 * - provider categories come back as hints; the backend maps them to categories
 */
export interface SyncUpdate {
  id: Id;
  changes: Partial<Transaction>;
  reason: string;
}

export interface SyncRemoval {
  id: Id;
  externalId: string | null;
  reason: 'provider_removed' | 'pending_expired';
  /** Keep the row (marked excluded) instead of deleting it. */
  hadUserEdits: boolean;
}

export interface SyncPlan {
  inserts: Transaction[];
  updates: SyncUpdate[];
  removals: SyncRemoval[];
  /** Provider category label per provider id (new and updated rows). */
  categoryHints: Record<string, string>;
  stats: { unmappedAccount: number };
}

export interface SyncPlanInput {
  connectionId: Id;
  /** Provider account id -> our account id. */
  accounts: ReadonlyMap<string, Id>;
  /** Existing connector transactions of those accounts. */
  existing: readonly Transaction[];
  result: Pick<SyncResult, 'transactions' | 'removedTransactionExternalIds'>;
  now: string;
}

function providerFields(p: ProviderTransaction): Partial<Transaction> {
  return {
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
}

export function planSync(input: SyncPlanInput): SyncPlan {
  const { result, accounts, existing, now } = input;
  const byExternal = new Map<string, Transaction>();
  for (const t of existing) if (t.externalId) byExternal.set(`${t.accountId}|${t.externalId}`, t);
  const plan: SyncPlan = {
    inserts: [],
    updates: [],
    removals: [],
    categoryHints: {},
    stats: { unmappedAccount: 0 },
  };
  const touched = new Set<Id>();
  for (const p of result.transactions) {
    const accountId = accounts.get(p.accountExternalId);
    if (!accountId) {
      plan.stats.unmappedAccount += 1;
      continue;
    }
    if (p.categoryHint) plan.categoryHints[p.externalId] = p.categoryHint;
    const current =
      byExternal.get(`${accountId}|${p.externalId}`) ??
      (p.pendingExternalId ? byExternal.get(`${accountId}|${p.pendingExternalId}`) : undefined);
    if (current) {
      if (touched.has(current.id)) continue;
      touched.add(current.id);
      const fields = providerFields(p);
      if (current.rawName === current.name && p.rawName !== current.rawName)
        fields.name = p.merchantName ?? p.rawName;
      const { transaction } = mergeRespectingUserEdits(current, fields);
      const changes: Partial<Transaction> = {};
      for (const k of Object.keys(fields) as (keyof Transaction)[]) {
        if (JSON.stringify(transaction[k]) !== JSON.stringify(current[k])) {
          (changes as Record<string, unknown>)[k] = transaction[k];
        }
      }
      if (Object.keys(changes).length > 0) {
        plan.updates.push({
          id: current.id,
          changes: { ...changes, updatedAt: now },
          reason: current.externalId !== p.externalId ? 'pending_posted' : 'provider_changed',
        });
      }
      byExternal.set(`${accountId}|${p.externalId}`, transaction);
      continue;
    }
    const txn = makeTransaction(
      {
        accountId,
        currency: p.currency,
        date: p.date,
        amount: p.amount,
        rawName: p.rawName,
        name: p.merchantName ?? p.rawName,
        source: 'connector',
        connectionId: input.connectionId,
        ...providerFields(p),
      },
      now,
    );
    plan.inserts.push(txn);
    byExternal.set(`${accountId}|${p.externalId}`, txn);
  }
  const removed = new Set(result.removedTransactionExternalIds);
  for (const t of existing) {
    if (t.externalId && removed.has(t.externalId) && !touched.has(t.id) && !t.isSplitParent) {
      plan.removals.push({
        id: t.id,
        externalId: t.externalId,
        reason: 'provider_removed',
        hadUserEdits: t.userEditedFields.length > 0 || t.splitParentId !== null,
      });
    }
  }
  return plan;
}

/** Turns category hints into categories for rows whose category is empty and not user-edited. */
export function categoryFromHint(
  txn: Transaction,
  hint: string | undefined,
  categoryByName: ReadonlyMap<string, Id>,
): Partial<Transaction> | null {
  if (!hint || txn.categoryId || txn.userEditedFields.includes('categoryId')) return null;
  const id = categoryByName.get(hint.toLowerCase());
  return id ? { categoryId: id, categorySource: 'provider' } : null;
}

export type { Connection };
