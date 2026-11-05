import type { Account, Connection, SyncResult } from '@manaclaude/shared';
import { batchInChunks, insertStatement, selectAll, updateStatement } from '../db/table';
import { accountsTable, categoriesTable, connectionsTable, transactionsTable } from '../db/tables';
import { newId, nowIso } from '../util/ids';
import { recordAtmWithdrawals } from '../services/cash';
import { runTransferMatcher } from '../services/matcher';
import { runRules } from '../services/rules';
import { planSync } from './plan';

export interface SyncSummary {
  accountsCreated: number;
  inserted: number;
  updated: number;
  removed: number;
  linked: number;
  suggested: number;
}

/**
 * Applies a connector's SyncResult to D1: upserts accounts and balances, then
 * transaction inserts/updates/removals, then rules on new rows, ATM cash
 * deposits and the transfer matcher.
 */
export async function applySyncResult(
  db: D1Database,
  connection: Connection,
  result: SyncResult,
  now = nowIso(),
): Promise<SyncSummary> {
  const existingAccounts = await selectAll(db, accountsTable, 'connection_id = ?', [connection.id]);
  const byExternal = new Map<string, Account>();
  for (const a of existingAccounts) if (a.externalId) byExternal.set(a.externalId, a);
  const accountStatements: D1PreparedStatement[] = [];
  let accountsCreated = 0;
  for (const p of result.accounts) {
    const current = byExternal.get(p.externalId);
    if (current) {
      accountStatements.push(
        updateStatement(db, accountsTable, { id: current.id }, {
          balance: p.balance,
          availableBalance: p.availableBalance,
          creditLimit: p.creditLimit,
          balanceAsOf: now,
          updatedAt: now,
        }),
      );
      continue;
    }
    const account: Account = {
      id: newId('acc'),
      name: p.name,
      institutionName: p.institutionName,
      type: p.type,
      subtype: p.subtype,
      currency: p.currency,
      balance: p.balance,
      balanceAsOf: now,
      availableBalance: p.availableBalance,
      creditLimit: p.creditLimit,
      mask: p.mask,
      connectionId: connection.id,
      externalId: p.externalId,
      includeInNetWorth: true,
      hidden: false,
      isDefaultCash: false,
      interestRate: null,
      openedOn: null,
      createdAt: now,
      updatedAt: now,
    };
    byExternal.set(p.externalId, account);
    accountStatements.push(insertStatement(db, accountsTable, account));
    accountsCreated += 1;
  }
  const accountIds = [...byExternal.values()].map((a) => a.id);
  accountStatements.push(
    updateStatement(db, connectionsTable, { id: connection.id }, {
      accountIds,
      syncCursor: result.nextCursor,
      lastSyncAt: now,
      lastSuccessfulSyncAt: now,
      status: 'healthy',
      lastError: null,
      updatedAt: now,
    }),
  );
  await batchInChunks(db, accountStatements);

  const existing =
    accountIds.length === 0
      ? []
      : await selectAll(
          db,
          transactionsTable,
          `source = 'connector' AND account_id IN (${accountIds.map(() => '?').join(',')})`,
          accountIds,
        );
  const categories = await selectAll(db, categoriesTable);
  const plan = planSync({ connection, result, accountsByExternalId: byExternal, existing, categories, now });
  const statements: D1PreparedStatement[] = [
    ...plan.inserts.map((t) => insertStatement(db, transactionsTable, t, 'ignore')),
    ...plan.updates.map((u) => insertStatement(db, transactionsTable, u.after, 'upsert')),
  ];
  for (const id of plan.removals) {
    statements.push(
      db.prepare("UPDATE transfer_links SET status = 'rejected', updated_at = ? WHERE (out_transaction_id = ? OR in_transaction_id = ?) AND status != 'rejected'").bind(now, id, id),
      db.prepare('UPDATE transactions SET transfer_link_id = NULL WHERE transfer_link_id IN (SELECT id FROM transfer_links WHERE out_transaction_id = ? OR in_transaction_id = ?)').bind(id, id),
      db.prepare('DELETE FROM transactions WHERE id = ? OR split_parent_id = ?').bind(id, id),
    );
  }
  await batchInChunks(db, statements);
  await runRules(db, plan.inserts.map((t) => t.id));
  const atm = await recordAtmWithdrawals(db, plan.inserts);
  const match = await runTransferMatcher(db);
  return {
    accountsCreated,
    inserted: plan.inserts.length,
    updated: plan.updates.length,
    removed: plan.removals.length,
    linked: match.linked + atm,
    suggested: match.suggested,
  };
}

/** Marks a connection as needing repair (expired login, MFA) without deleting anything. */
export async function markConnectionError(
  db: D1Database,
  connection: Connection,
  status: Connection['status'],
  message: string,
): Promise<void> {
  const now = nowIso();
  await updateStatement(db, connectionsTable, { id: connection.id }, {
    status,
    lastError: message.slice(0, 200),
    lastSyncAt: now,
    updatedAt: now,
  }).run();
}
