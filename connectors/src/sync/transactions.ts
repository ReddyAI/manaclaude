import type {
  Id,
  IsoDateTime,
  LocalDate,
  ProviderTransaction,
  SyncResult,
  Transaction,
  UserEditableField,
} from '@manaclaude/shared';
import { addDays } from '@manaclaude/shared';
import { cleanName } from '../kit';
import { defaultIdFactory, type IdFactory, type Update } from './types';

/**
 * Turn one provider sync into inserts, updates and removals for transactions.
 * No database code: session B's backend reads the rows, calls this, and applies
 * the result in one D1 batch.
 *
 * Ported from the behaviour of Sure's Account::ProviderImportAdapter
 * (app/models/account/provider_import_adapter.rb): find by (account, source,
 * external id); reconcile pending to posted by the provider's pending id first
 * and by exact amount inside a date window second; claim an unlinked manual or
 * imported duplicate once; leave user-edited entries alone.
 */

export interface TransactionSyncOptions {
  /**
   * Claim existing rows without a provider id (manual entries, file imports)
   * when a new provider row has the same account, amount and date. Each
   * existing row is claimed at most once, so two identical coffees stay two.
   */
  claimUnlinked?: boolean;
  /** Days around the posted date to look for an unlinked row to claim. Default 0 (same day). */
  claimDateWindowDays?: number;
  /** Match a posted row to a pending one by amount when the provider gives no pending id. Default true. */
  heuristicPendingMatch?: boolean;
  /** How many days before the posted date a pending row may sit. Default 8 (Sure's window). */
  pendingWindowDays?: number;
  /**
   * Pending rows older than this many days that the provider no longer reports
   * are removed (a voided hold). null turns this off. Default 21.
   */
  pendingExpiryDays?: number | null;
}

export interface TransactionSyncInput {
  connectionId: Id;
  /** Provider account id to our Account id, for the accounts of this connection. */
  accounts: ReadonlyMap<string, Id>;
  /** Existing rows of those accounts (every source; the function ignores what it should). */
  existing: readonly Transaction[];
  result: Pick<SyncResult, 'transactions' | 'removedTransactionExternalIds'>;
  now: IsoDateTime;
  newId?: IdFactory;
  options?: TransactionSyncOptions;
}

export interface TransactionRemoval {
  id: Id;
  externalId: string | null;
  reason: 'provider_removed' | 'pending_expired';
  /**
   * The user changed this row. The backend should keep it but mark it excluded
   * instead of deleting it, so their category and notes are not lost silently.
   */
  hadUserEdits: boolean;
}

export interface TransactionSyncOutput {
  inserts: Transaction[];
  updates: Update<Transaction>[];
  removals: TransactionRemoval[];
  /** Provider category label per new row's externalId, a hint for rules and AI only. */
  categoryHints: Record<string, string>;
  stats: {
    inserted: number;
    updated: number;
    removed: number;
    /** Provider rows whose account is not linked in `accounts`. */
    unmappedAccount: number;
    /** Provider rows repeated inside this result (kept once). */
    repeatedInResult: number;
    postedFromPending: number;
    claimedUnlinked: number;
  };
}

function key(accountId: Id, externalId: string): string {
  return `${accountId}\u0000${externalId}`;
}

function normalizeName(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function daysBetween(from: LocalDate, to: LocalDate): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function buildNew(
  p: ProviderTransaction,
  accountId: Id,
  connectionId: Id,
  now: IsoDateTime,
  id: Id,
): Transaction {
  return {
    id,
    accountId,
    date: p.date,
    amount: p.amount,
    currency: p.currency,
    originalAmount: p.originalAmount ?? p.amount,
    originalCurrency: p.originalCurrency ?? p.currency,
    name: p.merchantName?.trim() ? p.merchantName.trim() : cleanName(p.rawName),
    rawName: p.rawName,
    merchantId: null,
    categoryId: null,
    categorySource: null,
    aiCategoryConfidence: null,
    kind: 'regular',
    pending: p.pending,
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
    connectionId,
    externalId: p.externalId,
    pendingExternalId: p.pendingExternalId,
    importId: null,
    importFingerprint: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Fields of `existing` to change so it matches `p`, honouring userEditedFields. */
function diff(
  existing: Transaction,
  p: ProviderTransaction,
  now: IsoDateTime,
): Partial<Transaction> {
  const edited = new Set<UserEditableField>(existing.userEditedFields);
  const changes: Partial<Transaction> = {};
  const set = <K extends keyof Transaction>(field: K, value: Transaction[K]): void => {
    if (existing[field] !== value) changes[field] = value;
  };

  if (!edited.has('amount')) {
    set('amount', p.amount);
    set('originalAmount', p.originalAmount ?? p.amount);
    set('originalCurrency', p.originalCurrency ?? p.currency);
  }
  if (!edited.has('date')) set('date', p.date);
  if (!edited.has('name')) {
    const name = p.merchantName?.trim() ? p.merchantName.trim() : cleanName(p.rawName);
    set('name', name);
  }
  set('rawName', p.rawName);
  set('currency', p.currency);
  // A posted row never goes back to pending.
  set('pending', existing.pending && p.pending);
  if (p.pendingExternalId !== null) set('pendingExternalId', p.pendingExternalId);
  if (Object.keys(changes).length > 0) changes.updatedAt = now;
  return changes;
}

export function planTransactionSync(input: TransactionSyncInput): TransactionSyncOutput {
  const newId = input.newId ?? defaultIdFactory;
  const opts = {
    claimUnlinked: input.options?.claimUnlinked ?? true,
    claimDateWindowDays: input.options?.claimDateWindowDays ?? 0,
    heuristicPendingMatch: input.options?.heuristicPendingMatch ?? true,
    pendingWindowDays: input.options?.pendingWindowDays ?? 8,
    pendingExpiryDays:
      input.options?.pendingExpiryDays === undefined ? 21 : input.options.pendingExpiryDays,
  };
  const accountIds = new Set(input.accounts.values());
  const rows = input.existing.filter((t) => accountIds.has(t.accountId));

  const byExternal = new Map<string, Transaction>();
  for (const t of rows) {
    if (t.source === 'connector' && t.externalId) byExternal.set(key(t.accountId, t.externalId), t);
  }
  const pendingRows = rows.filter((t) => t.source === 'connector' && t.pending);
  const unlinkedRows = rows.filter(
    (t) => t.externalId === null && t.source !== 'connector' && !t.isSplitParent && !t.pending,
  );

  const out: TransactionSyncOutput = {
    inserts: [],
    updates: [],
    removals: [],
    categoryHints: {},
    stats: {
      inserted: 0,
      updated: 0,
      removed: 0,
      unmappedAccount: 0,
      repeatedInResult: 0,
      postedFromPending: 0,
      claimedUnlinked: 0,
    },
  };

  // The same provider id twice in one result is one transaction; keep the last copy.
  const incoming = new Map<string, ProviderTransaction>();
  for (const p of input.result.transactions) {
    const accountId = input.accounts.get(p.accountExternalId);
    if (!accountId) {
      out.stats.unmappedAccount++;
      continue;
    }
    const k = key(accountId, p.externalId);
    if (incoming.has(k)) out.stats.repeatedInResult++;
    incoming.set(k, p);
  }

  const claimedRowIds = new Set<Id>(); // existing rows already matched to an incoming row
  const touchedRowIds = new Set<Id>(); // existing rows that the provider reported this time

  // Pass 1: rows we already know by provider id.
  const unmatched: { p: ProviderTransaction; accountId: Id }[] = [];
  for (const [k, p] of incoming) {
    const accountId = input.accounts.get(p.accountExternalId) as Id;
    const found = byExternal.get(k);
    if (found) {
      claimedRowIds.add(found.id);
      touchedRowIds.add(found.id);
      const changes = diff(found, p, input.now);
      if (Object.keys(changes).length > 0) {
        out.updates.push({ id: found.id, changes, reason: 'refresh' });
      }
    } else {
      unmatched.push({ p, accountId });
    }
  }

  // Pass 2: pending to posted by the provider's pending id (Plaid), then new rows.
  const afterPendingId: { p: ProviderTransaction; accountId: Id }[] = [];
  for (const item of unmatched) {
    const { p, accountId } = item;
    const linked =
      !p.pending && p.pendingExternalId
        ? byExternal.get(key(accountId, p.pendingExternalId))
        : undefined;
    if (linked && !claimedRowIds.has(linked.id)) {
      claimRow(linked, p, 'posted_from_pending');
      out.stats.postedFromPending++;
    } else {
      afterPendingId.push(item);
    }
  }

  // Pass 3: heuristics for rows that still have no home. Posted rows only.
  for (const { p, accountId } of afterPendingId) {
    if (!p.pending && opts.heuristicPendingMatch) {
      const candidate = pickPending(p, accountId);
      if (candidate) {
        claimRow(candidate, p, 'posted_from_pending');
        out.stats.postedFromPending++;
        continue;
      }
    }
    if (!p.pending && opts.claimUnlinked) {
      const candidate = pickUnlinked(p, accountId);
      if (candidate) {
        claimRow(candidate, p, 'claimed_unlinked');
        out.stats.claimedUnlinked++;
        continue;
      }
    }
    const row = buildNew(p, accountId, input.connectionId, input.now, newId('txn'));
    out.inserts.push(row);
    if (p.externalId && p.categoryHint) out.categoryHints[p.externalId] = p.categoryHint;
  }

  // Removals the provider asked for. A row we just turned into the posted
  // version is not removed even though its old pending id is in the list.
  const removedIds = new Set(input.result.removedTransactionExternalIds);
  for (const row of rows) {
    if (row.source !== 'connector' || !row.externalId) continue;
    if (!removedIds.has(row.externalId) || claimedRowIds.has(row.id)) continue;
    out.removals.push({
      id: row.id,
      externalId: row.externalId,
      reason: 'provider_removed',
      hadUserEdits: row.userEditedFields.length > 0,
    });
  }

  // Pending holds that vanished without a replacement.
  if (opts.pendingExpiryDays !== null) {
    const today = input.now.slice(0, 10);
    const cutoff = addDays(today, -opts.pendingExpiryDays);
    const alreadyRemoved = new Set(out.removals.map((r) => r.id));
    for (const row of pendingRows) {
      if (touchedRowIds.has(row.id) || claimedRowIds.has(row.id) || alreadyRemoved.has(row.id))
        continue;
      if (row.date > cutoff) continue;
      out.removals.push({
        id: row.id,
        externalId: row.externalId,
        reason: 'pending_expired',
        hadUserEdits: row.userEditedFields.length > 0,
      });
    }
  }

  out.stats.inserted = out.inserts.length;
  out.stats.updated = out.updates.length;
  out.stats.removed = out.removals.length;
  return out;

  // -- helpers (closures over the maps above) ------------------------------

  function claimRow(row: Transaction, p: ProviderTransaction, reason: string): void {
    claimedRowIds.add(row.id);
    touchedRowIds.add(row.id);
    // An unlinked row keeps what the file or the user wrote; it only gains the provider identity.
    const changes: Partial<Transaction> =
      reason === 'claimed_unlinked' ? {} : { ...diff(row, p, input.now) };
    if (
      reason !== 'claimed_unlinked' &&
      row.externalId !== null &&
      row.externalId !== p.externalId
    ) {
      changes.pendingExternalId = row.externalId;
    }
    if (reason === 'claimed_unlinked' && p.pendingExternalId)
      changes.pendingExternalId = p.pendingExternalId;
    changes.externalId = p.externalId;
    changes.source = 'connector';
    changes.connectionId = input.connectionId;
    changes.pending = false;
    changes.updatedAt = input.now;
    out.updates.push({ id: row.id, changes, reason });
    // The new id now belongs to this row, so a later duplicate in this batch matches it.
    byExternal.set(key(row.accountId, p.externalId), { ...row, ...changes } as Transaction);
  }

  function pickPending(p: ProviderTransaction, accountId: Id): Transaction | undefined {
    const candidates = pendingRows.filter(
      (t) =>
        t.accountId === accountId &&
        !claimedRowIds.has(t.id) &&
        !touchedRowIds.has(t.id) &&
        t.amount === p.amount &&
        t.currency === p.currency &&
        t.date <= p.date &&
        daysBetween(t.date, p.date) <= opts.pendingWindowDays,
    );
    if (candidates.length === 0) return undefined;
    const wanted = normalizeName(p.merchantName ?? p.rawName);
    candidates.sort((a, b) => {
      const an = normalizeName(a.rawName) === wanted || normalizeName(a.name) === wanted ? 0 : 1;
      const bn = normalizeName(b.rawName) === wanted || normalizeName(b.name) === wanted ? 0 : 1;
      return an - bn || b.date.localeCompare(a.date) || a.id.localeCompare(b.id);
    });
    return candidates[0];
  }

  function pickUnlinked(p: ProviderTransaction, accountId: Id): Transaction | undefined {
    const candidates = unlinkedRows.filter(
      (t) =>
        t.accountId === accountId &&
        !claimedRowIds.has(t.id) &&
        t.amount === p.amount &&
        t.currency === p.currency &&
        Math.abs(daysBetween(t.date, p.date)) <= opts.claimDateWindowDays,
    );
    candidates.sort(
      (a, b) =>
        Math.abs(daysBetween(a.date, p.date)) - Math.abs(daysBetween(b.date, p.date)) ||
        a.id.localeCompare(b.id),
    );
    return candidates[0];
  }
}
