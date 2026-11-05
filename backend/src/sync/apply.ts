import {
  afterSyncSuccess,
  planAccountSync,
  planInvestmentSync,
  planTransactionSync,
  type IdFactory,
} from '@manaclaude/connectors';
import type { Connection, Id, SyncResult, Transaction } from '@manaclaude/shared';
import { insertStatement, selectAll, updateStatement } from '../db/table';
import {
  accountsTable,
  activitiesTable,
  balanceSnapshotsTable,
  categoriesTable,
  connectionsTable,
  holdingsTable,
  securitiesTable,
  taxLotsTable,
  transactionsTable,
} from '../db/tables';
import { newId, nowIso } from '../util/ids';
import { recordAtmWithdrawals } from '../services/cash';
import { runTransferMatcher } from '../services/matcher';
import { runRules } from '../services/rules';

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
}

/** D1 runs one batch as one transaction. Past this size a plan is split to stay under platform limits. */
export const MAX_BATCH_STATEMENTS = 500;

/**
 * Runs the statements of one plan as one D1 batch (all or nothing). A plan
 * longer than MAX_BATCH_STATEMENTS (a first sync with years of history) is
 * split into consecutive batches; every statement is safe to repeat, so a
 * failed sync is simply run again.
 */
export async function runPlanBatch(
  db: D1Database,
  statements: D1PreparedStatement[],
): Promise<void> {
  for (let i = 0; i < statements.length; i += MAX_BATCH_STATEMENTS) {
    await db.batch(statements.slice(i, i + MAX_BATCH_STATEMENTS));
  }
}

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

/**
 * Applies a connector's SyncResult to D1 using session D's planners:
 * planAccountSync (accounts, balances, snapshots), planTransactionSync
 * (inserts, updates, removals) and planInvestmentSync (securities, holdings,
 * lots, activities). Each plan is written as one D1 batch, in that order, and
 * the connection row (cursor, last sync, health) is written in the last batch,
 * so a failure before the end leaves the cursor where it was and the next sync
 * reads the same window again. Then rules run on the new rows, ATM withdrawals
 * get their cash deposit, and the transfer matcher runs.
 */
export async function applySyncResult(
  db: D1Database,
  connection: Connection,
  result: SyncResult,
  now = nowIso(),
): Promise<SyncSummary> {
  const warnings: string[] = [];

  // -- accounts --------------------------------------------------------------
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
  const accountStatements: D1PreparedStatement[] = [
    ...accountPlan.inserts.map((a) => insertStatement(db, accountsTable, a)),
    ...accountPlan.updates
      .filter((u) => Object.keys(u.changes).length > 0)
      .map((u) => updateStatement(db, accountsTable, { id: u.id }, u.changes)),
    ...accountPlan.balanceSnapshots.map((s) =>
      insertStatement(db, balanceSnapshotsTable, s, 'upsert'),
    ),
  ];
  const syncedAccountIds = [...accountPlan.accountIds.values()];
  const connectionAccountIds = [
    ...new Set([
      ...allAccounts.filter((a) => a.connectionId === connection.id).map((a) => a.id),
      ...accountPlan.inserts.map((a) => a.id),
    ]),
  ];

  // -- transactions ----------------------------------------------------------
  const existing =
    syncedAccountIds.length === 0
      ? []
      : await selectAll(
          db,
          transactionsTable,
          `account_id IN (${placeholders(syncedAccountIds.length)})`,
          syncedAccountIds,
        );
  const categories = await selectAll(db, categoriesTable);
  const categoryByName = new Map(categories.map((c) => [c.name.toLowerCase(), c.id]));
  const txnPlan = planTransactionSync({
    connectionId: connection.id,
    accounts: accountPlan.accountIds,
    existing,
    result,
    now,
    newId: idFactory,
  });
  const byId = new Map(existing.map((t) => [t.id, t]));
  const inserts = txnPlan.inserts.map((t) => {
    const hint = t.externalId ? txnPlan.categoryHints[t.externalId] : undefined;
    const fromHint = categoryFromHint(t, hint, categoryByName);
    return fromHint ? { ...t, ...fromHint } : t;
  });
  const txnStatements: D1PreparedStatement[] = inserts.map((t) =>
    insertStatement(db, transactionsTable, t, 'ignore'),
  );
  for (const u of txnPlan.updates) {
    if (Object.keys(u.changes).length === 0) continue;
    txnStatements.push(updateStatement(db, transactionsTable, { id: u.id }, u.changes));
  }
  let removed = 0;
  for (const r of txnPlan.removals) {
    const row = byId.get(r.id);
    // A split the user made stays whole; a row they touched or attached a receipt to is kept, out of reports.
    if (row?.isSplitParent) continue;
    removed += 1;
    const keep = r.hadUserEdits || (row?.receiptId ?? null) !== null;
    txnStatements.push(
      db
        .prepare(
          "UPDATE transfer_links SET status = 'rejected', updated_at = ? WHERE (out_transaction_id = ? OR in_transaction_id = ?) AND status != 'rejected'",
        )
        .bind(now, r.id, r.id),
      db
        .prepare(
          'UPDATE transactions SET transfer_link_id = NULL WHERE transfer_link_id IN (SELECT id FROM transfer_links WHERE out_transaction_id = ? OR in_transaction_id = ?)',
        )
        .bind(r.id, r.id),
      keep
        ? db
            .prepare('UPDATE transactions SET excluded = 1, updated_at = ? WHERE id = ?')
            .bind(now, r.id)
        : db
            .prepare('DELETE FROM transactions WHERE id = ? OR split_parent_id = ?')
            .bind(r.id, r.id),
    );
  }

  // -- investments -----------------------------------------------------------
  const invStatements: D1PreparedStatement[] = [];
  let holdingsTouched = 0;
  let activitiesTouched = 0;
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
    const inv = planInvestmentSync({
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
    holdingsTouched = inv.holdingInserts.length + inv.holdingUpdates.length;
    activitiesTouched = inv.activityInserts.length + inv.activityUpdates.length;
    for (const s of inv.securityInserts)
      invStatements.push(insertStatement(db, securitiesTable, s, 'ignore'));
    for (const h of inv.holdingInserts)
      invStatements.push(insertStatement(db, holdingsTable, h));
    for (const u of inv.holdingUpdates)
      invStatements.push(updateStatement(db, holdingsTable, { id: u.id }, u.changes));
    for (const id of inv.holdingRemovals)
      invStatements.push(db.prepare('DELETE FROM holdings WHERE id = ?').bind(id));
    for (const l of inv.lotInserts) invStatements.push(insertStatement(db, taxLotsTable, l));
    for (const u of inv.lotUpdates)
      invStatements.push(updateStatement(db, taxLotsTable, { id: u.id }, u.changes));
    for (const id of inv.lotRemovals)
      invStatements.push(db.prepare('DELETE FROM tax_lots WHERE id = ?').bind(id));
    for (const a of inv.activityInserts)
      invStatements.push(insertStatement(db, activitiesTable, a, 'ignore'));
    for (const u of inv.activityUpdates)
      invStatements.push(updateStatement(db, activitiesTable, { id: u.id }, u.changes));
  }

  // -- write: accounts, transactions, then investments and the connection row ----
  const after = afterSyncSuccess(connection, now, result.nextCursor, connectionAccountIds);
  const connectionStatement = updateStatement(
    db,
    connectionsTable,
    { id: connection.id },
    {
      accountIds: after.accountIds,
      syncCursor: after.syncCursor,
      lastSyncAt: after.lastSyncAt,
      lastSuccessfulSyncAt: after.lastSuccessfulSyncAt,
      status: after.status,
      lastError: after.lastError,
      updatedAt: after.updatedAt,
    },
  );
  await runPlanBatch(db, accountStatements);
  await runPlanBatch(db, txnStatements);
  await runPlanBatch(db, [...invStatements, connectionStatement]);

  // -- after the data is saved ---------------------------------------------------
  await runRules(
    db,
    inserts.map((t) => t.id),
  );
  const atm = await recordAtmWithdrawals(db, inserts);
  const match = await runTransferMatcher(db);
  return {
    accountsCreated: accountPlan.inserts.length,
    inserted: inserts.length,
    updated: txnPlan.updates.length,
    removed,
    linked: match.linked + atm,
    suggested: match.suggested,
    holdings: holdingsTouched,
    activities: activitiesTouched,
    warnings,
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
