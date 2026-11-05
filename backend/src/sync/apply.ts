import type { Account, Connection, SyncResult } from '@manaclaude/shared';
import { batchInChunks, insertStatement, selectAll, updateStatement } from '../db/table';
import { accountsTable, categoriesTable, connectionsTable, transactionsTable } from '../db/tables';
import { newId, nowIso } from '../util/ids';
import { recordAtmWithdrawals } from '../services/cash';
import { runTransferMatcher } from '../services/matcher';
import { runRules } from '../services/rules';
import { categoryFromHint, planSync } from './plan';

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
        updateStatement(
          db,
          accountsTable,
          { id: current.id },
          {
            balance: p.balance,
            availableBalance: p.availableBalance,
            creditLimit: p.creditLimit,
            balanceAsOf: now,
            updatedAt: now,
          },
        ),
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
    updateStatement(
      db,
      connectionsTable,
      { id: connection.id },
      {
        accountIds,
        syncCursor: result.nextCursor,
        lastSyncAt: now,
        lastSuccessfulSyncAt: now,
        status: 'healthy',
        lastError: null,
        updatedAt: now,
      },
    ),
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
  const categoryByName = new Map(categories.map((c) => [c.name.toLowerCase(), c.id]));
  // When session D's planTransactionSync lands on main, call it here instead:
  // it takes the same input and returns the same shape.
  const plan = planSync({
    connectionId: connection.id,
    accounts: new Map([...byExternal.entries()].map(([ext, a]) => [ext, a.id])),
    existing,
    result,
    now,
  });
  const byId = new Map(existing.map((t) => [t.id, t]));
  const inserts = plan.inserts.map((t) => {
    const hint = t.externalId ? plan.categoryHints[t.externalId] : undefined;
    const fromHint = categoryFromHint(t, hint, categoryByName);
    return fromHint ? { ...t, ...fromHint } : t;
  });
  const statements: D1PreparedStatement[] = inserts.map((t) =>
    insertStatement(db, transactionsTable, t, 'ignore'),
  );
  for (const u of plan.updates) {
    const before = byId.get(u.id);
    const after = before ? { ...before, ...u.changes } : null;
    const hint = after?.externalId ? plan.categoryHints[after.externalId] : undefined;
    const fromHint = after ? categoryFromHint(after, hint, categoryByName) : null;
    statements.push(
      updateStatement(db, transactionsTable, { id: u.id }, { ...u.changes, ...(fromHint ?? {}) }),
    );
  }
  for (const r of plan.removals) {
    statements.push(
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
      r.hadUserEdits
        ? // Keep a row the user touched, out of reports, so their edits aren't lost silently.
          db
            .prepare('UPDATE transactions SET excluded = 1, updated_at = ? WHERE id = ?')
            .bind(now, r.id)
        : db
            .prepare('DELETE FROM transactions WHERE id = ? OR split_parent_id = ?')
            .bind(r.id, r.id),
    );
  }
  await batchInChunks(db, statements);
  await runRules(
    db,
    inserts.map((t) => t.id),
  );
  const atm = await recordAtmWithdrawals(db, inserts);
  const match = await runTransferMatcher(db);
  return {
    accountsCreated,
    inserted: inserts.length,
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
  await updateStatement(
    db,
    connectionsTable,
    { id: connection.id },
    {
      status,
      lastError: message.slice(0, 200),
      lastSyncAt: now,
      updatedAt: now,
    },
  ).run();
}
