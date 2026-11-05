import {
  afterSyncSuccess,
  planAccountSync,
  planInvestmentSync,
  planTransactionSync,
  type IdFactory,
} from '@manaclaude/connectors';
import {
  applyRules,
  type Connection,
  type Id,
  type SyncResult,
  type Transaction,
} from '@manaclaude/shared';
import { selectAll, updateStatement } from '../db/table';
import {
  bulkByIdsSpecs,
  bulkInsertSpecs,
  bulkUpdateSpecs,
  runSpecs,
  type StatementSpec,
} from '../db/bulk';
import type { QueryBudget } from '../db/meter';
import {
  accountsTable,
  activitiesTable,
  balanceSnapshotsTable,
  categoriesTable,
  connectionsTable,
  holdingsTable,
  rulesTable,
  securitiesTable,
  taxLotsTable,
  transactionsTable,
} from '../db/tables';
import { newId, nowIso } from '../util/ids';
import { recordAtmWithdrawals } from '../services/cash';
import { runTransferMatcher } from '../services/matcher';

export interface SyncSummary {
  accountsCreated: number;
  inserted: number;
  updated: number;
  removed: number;
  linked: number;
  suggested: number;
  /** Holdings added or refreshed by the investment plan. */
  holdings: number;
  /** Investment activities added or refreshed. */
  activities: number;
  /** Things the planners noticed (account in another connection, odd currency...). */
  warnings: string[];
  /**
   * Transactions and activities still to write. A long first sync stops after
   * maxRows rows; the connection stays "syncing" with its old cursor, and the
   * next sync (the app's next call or the five-minute cron) reads the same
   * window again and continues where this one stopped.
   */
  remaining: number;
  /** True when remaining > 0 and another sync call should follow. */
  more: boolean;
}

export interface ApplyOptions {
  /** Queries this call may still spend. Without one, nothing is held back. */
  budget?: QueryBudget;
  /** Most new transactions and activities written in one call (CPU and queries on the Free plan). */
  maxRows?: number;
}

/** New rows written per sync call. Three steps for the 3,000-row test fixture. */
export const MAX_ROWS_PER_SYNC = 1200;

/**
 * Queries kept back for the steps after the data is saved: ATM cash deposits
 * (about 9) and the transfer matcher (5 reads, up to 3 writes).
 */
export const AFTER_SYNC_RESERVE = 18;

const idFactory: IdFactory = (kind) => newId(kind);

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',');
}

/** Turns a provider category label into a category, only for rows with none and no user edit. */
export function categoryFromHint(
  txn: Transaction,
  hint: string | undefined,
  categoryByName: ReadonlyMap<string, Id>,
): Partial<Transaction> | null {
  if (!hint || txn.categoryId || txn.userEditedFields.includes('categoryId')) return null;
  const id = categoryByName.get(hint.toLowerCase());
  return id ? { categoryId: id, categorySource: 'provider' } : null;
}

const newestFirst = (a: { date: string }, b: { date: string }) =>
  a.date < b.date ? 1 : a.date > b.date ? -1 : 0;

/**
 * Applies a connector's SyncResult to D1 using session D's planners:
 * planAccountSync (accounts, balances, snapshots), planTransactionSync
 * (inserts, updates, removals) and planInvestmentSync (securities, holdings,
 * lots, activities).
 *
 * Writes are multi-row statements (db/bulk.ts), so the cost in D1 queries
 * depends on the number of tables touched, not the number of rows. Rules run
 * in memory on the new rows before they are written. New transactions and
 * activities go in newest first, at most `maxRows` per call: when more are
 * left, the connection is saved as "syncing" without moving its cursor, so the
 * next call fetches the same window, sees the rows already written as existing
 * (no duplicates) and writes the next part. Only the last part moves the
 * cursor and marks the connection healthy, and only then do ATM deposits and
 * the transfer matcher run.
 */
export async function applySyncResult(
  db: D1Database,
  connection: Connection,
  result: SyncResult,
  now = nowIso(),
  opts: ApplyOptions = {},
): Promise<SyncSummary> {
  const warnings: string[] = [];
  const maxRows = opts.maxRows ?? MAX_ROWS_PER_SYNC;

  // -- reads ---------------------------------------------------------------------
  const allAccounts = await selectAll(db, accountsTable);
  const accountPlan = planAccountSync({
    connectionId: connection.id,
    institutionName: connection.institutionName,
    existing: allAccounts,
    result,
    now,
    newId: idFactory,
  });
  for (const c of accountPlan.conflicts) {
    warnings.push(
      `Account ${c.externalId} already belongs to another connection and was not synced.`,
    );
  }
  warnings.push(...accountPlan.warnings);
  const syncedAccountIds = [...accountPlan.accountIds.values()];
  const connectionAccountIds = [
    ...new Set([
      ...allAccounts.filter((a) => a.connectionId === connection.id).map((a) => a.id),
      ...accountPlan.inserts.map((a) => a.id),
    ]),
  ];
  const accountSpecs: StatementSpec[] = [
    ...bulkInsertSpecs(accountsTable, accountPlan.inserts),
    ...bulkUpdateSpecs(
      accountsTable,
      accountPlan.updates.map((u) => ({ key: { id: u.id }, changes: u.changes })),
    ),
    ...bulkInsertSpecs(balanceSnapshotsTable, accountPlan.balanceSnapshots, 'upsert'),
  ];

  const existing =
    syncedAccountIds.length === 0
      ? []
      : await selectAll(
          db,
          transactionsTable,
          `account_id IN (${placeholders(syncedAccountIds.length)})`,
          syncedAccountIds,
        );
  const txnPlan = planTransactionSync({
    connectionId: connection.id,
    accounts: accountPlan.accountIds,
    existing,
    result,
    now,
    newId: idFactory,
  });
  const [categories, rules] =
    txnPlan.inserts.length > 0
      ? await Promise.all([
          selectAll(db, categoriesTable),
          selectAll(db, rulesTable, 'enabled = 1'),
        ])
      : [[], []];
  const categoryByName = new Map(categories.map((c) => [c.name.toLowerCase(), c.id]));
  const allInserts = txnPlan.inserts
    .map((t) => {
      const hint = t.externalId ? txnPlan.categoryHints[t.externalId] : undefined;
      const fromHint = categoryFromHint(t, hint, categoryByName);
      const withHint = fromHint ? { ...t, ...fromHint } : t;
      return rules.length > 0 ? applyRules(withHint, rules).transaction : withHint;
    })
    .sort(newestFirst);

  // -- investments (reads) ----------------------------------------------------------
  let inv: ReturnType<typeof planInvestmentSync> | null = null;
  if (result.holdings.length > 0 || result.activities.length > 0) {
    const ph = placeholders(syncedAccountIds.length);
    const [securities, holdings, taxLots, activities] = await Promise.all([
      selectAll(db, securitiesTable),
      syncedAccountIds.length
        ? selectAll(db, holdingsTable, `account_id IN (${ph})`, syncedAccountIds)
        : [],
      syncedAccountIds.length
        ? selectAll(
            db,
            taxLotsTable,
            `holding_id IN (SELECT id FROM holdings WHERE account_id IN (${ph}))`,
            syncedAccountIds,
          )
        : [],
      syncedAccountIds.length
        ? selectAll(db, activitiesTable, `account_id IN (${ph})`, syncedAccountIds)
        : [],
    ]);
    inv = planInvestmentSync({
      connectionId: connection.id,
      accounts: accountPlan.accountIds,
      securities,
      holdings,
      taxLots,
      activities,
      result,
      now,
      newId: idFactory,
    });
    warnings.push(...inv.warnings);
  }
  const allActivityInserts = [...(inv?.activityInserts ?? [])].sort(newestFirst);

  // -- what fits in this call ------------------------------------------------------------
  const byId = new Map(existing.map((t) => [t.id, t]));
  const removals = txnPlan.removals.filter((r) => !byId.get(r.id)?.isSplitParent);
  const keepIds = removals
    .filter((r) => r.hadUserEdits || (byId.get(r.id)?.receiptId ?? null) !== null)
    .map((r) => r.id);
  const deleteIds = removals.map((r) => r.id).filter((id) => !keepIds.includes(id));
  const removedIds = removals.map((r) => r.id);

  const build = (txnCount: number, actCount: number) => {
    const inserts = allInserts.slice(0, txnCount);
    const activityInserts = allActivityInserts.slice(0, actCount);
    const txnSpecs: StatementSpec[] = [
      ...bulkInsertSpecs(transactionsTable, inserts, 'ignore'),
      ...bulkUpdateSpecs(
        transactionsTable,
        txnPlan.updates.map((u) => ({ key: { id: u.id }, changes: u.changes })),
      ),
      // A split the user made stays whole; a row they touched or attached a receipt to is kept, out of reports.
      ...bulkByIdsSpecs(
        "UPDATE transfer_links SET status = 'rejected', updated_at = ? WHERE status != 'rejected' AND (out_transaction_id IN (SELECT value FROM json_each(?2)) OR in_transaction_id IN (SELECT value FROM json_each(?2)))",
        removedIds,
        [now],
      ),
      ...bulkByIdsSpecs(
        'UPDATE transactions SET transfer_link_id = NULL WHERE transfer_link_id IN (SELECT id FROM transfer_links WHERE out_transaction_id IN (SELECT value FROM json_each(?1)) OR in_transaction_id IN (SELECT value FROM json_each(?1)))',
        removedIds,
      ),
      ...bulkByIdsSpecs(
        'UPDATE transactions SET excluded = 1, updated_at = ? WHERE id IN (SELECT value FROM json_each(?2))',
        keepIds,
        [now],
      ),
      ...bulkByIdsSpecs(
        'DELETE FROM transactions WHERE id IN (SELECT value FROM json_each(?1)) OR split_parent_id IN (SELECT value FROM json_each(?1))',
        deleteIds,
      ),
    ];
    const invSpecs: StatementSpec[] = inv
      ? [
          ...bulkInsertSpecs(securitiesTable, inv.securityInserts, 'ignore'),
          ...bulkInsertSpecs(holdingsTable, inv.holdingInserts),
          ...bulkUpdateSpecs(
            holdingsTable,
            inv.holdingUpdates.map((u) => ({ key: { id: u.id }, changes: u.changes })),
          ),
          ...bulkByIdsSpecs(
            'DELETE FROM holdings WHERE id IN (SELECT value FROM json_each(?1))',
            inv.holdingRemovals,
          ),
          ...bulkInsertSpecs(taxLotsTable, inv.lotInserts),
          ...bulkUpdateSpecs(
            taxLotsTable,
            inv.lotUpdates.map((u) => ({ key: { id: u.id }, changes: u.changes })),
          ),
          ...bulkByIdsSpecs(
            'DELETE FROM tax_lots WHERE id IN (SELECT value FROM json_each(?1))',
            inv.lotRemovals,
          ),
          ...bulkInsertSpecs(activitiesTable, activityInserts, 'ignore'),
          ...bulkUpdateSpecs(
            activitiesTable,
            inv.activityUpdates.map((u) => ({ key: { id: u.id }, changes: u.changes })),
          ),
        ]
      : [];
    return { inserts, activityInserts, specs: [...txnSpecs, ...invSpecs] };
  };

  let txnCount = Math.min(allInserts.length, maxRows);
  let actCount = Math.min(allActivityInserts.length, Math.max(0, maxRows - txnCount));
  let plan = build(txnCount, actCount);
  if (opts.budget) {
    // Account writes, the connection row, and (on the last part) the after-sync steps must fit too.
    const fits = () => {
      const last = txnCount === allInserts.length && actCount === allActivityInserts.length;
      const need = accountSpecs.length + plan.specs.length + 1 + (last ? AFTER_SYNC_RESERVE : 0);
      return opts.budget!.allows(need);
    };
    while (!fits() && txnCount + actCount > 0) {
      if (actCount > 0) actCount = Math.floor(actCount / 2);
      else txnCount = Math.floor(txnCount / 2);
      plan = build(txnCount, actCount);
    }
  }
  const remaining = allInserts.length - txnCount + (allActivityInserts.length - actCount);
  const more = remaining > 0;

  // -- write: accounts, then the data and the connection row ---------------------------
  const after = afterSyncSuccess(connection, now, result.nextCursor, connectionAccountIds);
  const connectionSpec = bulkUpdateSpecs(connectionsTable, [
    {
      key: { id: connection.id },
      changes: more
        ? {
            // Part of a long first sync: keep the old cursor so the next call reads the same window.
            accountIds: after.accountIds,
            lastSyncAt: now,
            status: 'syncing' as const,
            lastError: null,
            updatedAt: now,
          }
        : {
            accountIds: after.accountIds,
            syncCursor: after.syncCursor,
            lastSyncAt: after.lastSyncAt,
            lastSuccessfulSyncAt: after.lastSuccessfulSyncAt,
            status: after.status,
            lastError: after.lastError,
            updatedAt: after.updatedAt,
          },
    },
  ]);
  await runSpecs(db, accountSpecs);
  await runSpecs(db, [...plan.specs, ...connectionSpec]);

  // -- after the last part is saved -----------------------------------------------------
  let linked = 0;
  let suggested = 0;
  if (!more && (!opts.budget || opts.budget.allows(AFTER_SYNC_RESERVE))) {
    const atm = await recordAtmWithdrawals(db, undefined, { accountIds: connectionAccountIds });
    const match = await runTransferMatcher(db);
    linked = match.linked + atm;
    suggested = match.suggested;
  }
  return {
    accountsCreated: accountPlan.inserts.length,
    inserted: plan.inserts.length,
    updated: txnPlan.updates.length,
    removed: removals.length,
    linked,
    suggested,
    holdings: inv ? inv.holdingInserts.length + inv.holdingUpdates.length : 0,
    activities: plan.activityInserts.length + (inv?.activityUpdates.length ?? 0),
    warnings,
    remaining,
    more,
  };
}

/** Records a failed sync on the connection (status, short message) without touching its data. */
export async function markConnectionError(
  db: D1Database,
  connection: Connection,
  status: Connection['status'],
  message: string,
  now = nowIso(),
): Promise<void> {
  await updateStatement(
    db,
    connectionsTable,
    { id: connection.id },
    { status, lastError: message.slice(0, 200), lastSyncAt: now, updatedAt: now },
  ).run();
}
