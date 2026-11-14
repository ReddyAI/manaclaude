import { selectOne, updateStatement } from '../db/table';
import { accountsTable, transactionsTable } from '../db/tables';
import { conflict, notFound } from '../util/errors';
import { nowIso } from '../util/ids';
import { getAccount } from './accounts';
import { accountStateSql, guardedWrite, transactionStateSql } from './account-writes';

const eligibilitySql = `SELECT json_array(
  (${transactionStateSql}),
  (SELECT count(*) FROM transactions WHERE split_parent_id = ?1),
  (SELECT count(*) FROM split_locks WHERE parent_id = ?1),
  (SELECT count(*) FROM transfer_links WHERE (out_transaction_id = ?1 OR in_transaction_id = ?1) AND status != 'rejected')
) AS state WHERE EXISTS (SELECT 1 FROM transactions WHERE id = ?1)`;

/** Reverses the recorded quick-add balance effect, never an edited amount. */
export async function deleteCashTransaction(
  db: D1Database,
  id: string,
  clock: () => Date = () => new Date(),
) {
  const state = await db.prepare(eligibilitySql).bind(id).first<string>('state');
  if (!state) throw notFound('Transaction not found.');
  const txn = await selectOne(db, transactionsTable, 'id = ?', [id]);
  if (!txn) throw notFound('Transaction not found.');
  const account = await getAccount(db, txn.accountId);
  const accountState = await db.prepare(accountStateSql).bind(account.id).first<string>('state');
  const dependencies = JSON.parse(state) as [string, number, number, number];
  if (
    account.type !== 'cash' ||
    account.connectionId ||
    account.externalId ||
    txn.source !== 'manual' ||
    txn.connectionId ||
    txn.externalId ||
    txn.pendingExternalId ||
    txn.importId ||
    txn.importFingerprint ||
    txn.splitParentId ||
    txn.isSplitParent ||
    txn.transferLinkId ||
    dependencies.slice(1).some(Boolean)
  )
    throw conflict(
      'Only an unlinked, unsplit hand-entered cash transaction can be deleted. Undo its split or reject/unlink its transfer first.',
      'cash_delete_refused',
    );
  const effect = await db
    .prepare(
      `SELECT e.amount, e.generation,
    COALESCE(b.cash_generation, 0) AS current_generation
    FROM accounts a LEFT JOIN manual_balance_overrides b ON b.account_id = a.id
    LEFT JOIN cash_entry_effects e ON e.transaction_id = ?1 WHERE a.id = ?2`,
    )
    .bind(id, account.id)
    .first<{ amount: number | null; generation: number | null; current_generation: number }>();
  if (!effect) throw notFound('Account not found.');
  const impact =
    (effect.generation ?? 0) < effect.current_generation
      ? 0
      : effect.generation !== null
        ? effect.amount
        : txn.userEditedFields.includes('amount')
          ? null
          : txn.amount;
  if (impact === null)
    throw conflict(
      'The original balance effect is unknown. Set the cash account’s current balance first, then retry.',
      'cash_balance_unknown',
    );
  const known = account.manualBalance?.currentKnown !== false;
  const balance = known ? account.balance - impact : 0;
  if (!Number.isSafeInteger(balance))
    throw conflict(
      'Reversing this entry would exceed the safe balance range.',
      'cash_balance_overflow',
    );
  // Protect all values loaded above, including an effect changed by a balance reset.
  const current = await db.prepare(eligibilitySql).bind(id).first<string>('state');
  const accountNow = await getAccount(db, account.id);
  if (current !== state || !accountState || JSON.stringify(accountNow) !== JSON.stringify(account))
    throw conflict('Cash records changed. Reload before deleting.', 'account_changed');
  const now = nowIso(new Date(Math.max(clock().getTime(), Date.parse(account.updatedAt) + 1)));
  await guardedWrite(
    db,
    [
      { sql: eligibilitySql, id, state },
      { sql: accountStateSql, id: account.id, state: accountState },
    ],
    [
      updateStatement(
        db,
        accountsTable,
        { id: account.id },
        {
          balance,
          ...(known && impact !== 0 ? { balanceAsOf: now } : {}),
          updatedAt: now,
        },
      ),
      db
        .prepare(
          `UPDATE receipts SET matched_transaction_id = NULL, status = 'needs_review', updated_at = ?
      WHERE matched_transaction_id = ?`,
        )
        .bind(now, id),
      db.prepare('DELETE FROM alerts WHERE transaction_id = ?').bind(id),
      // Rejected pairs are no longer useful once an endpoint is gone.
      db
        .prepare(
          `DELETE FROM transfer_links WHERE status = 'rejected'
      AND (out_transaction_id = ?1 OR in_transaction_id = ?1)`,
        )
        .bind(id),
      db.prepare('DELETE FROM cash_entry_effects WHERE transaction_id = ?').bind(id),
      db.prepare('DELETE FROM transactions WHERE id = ?').bind(id),
    ],
  );
  return {
    deletedTransactionId: id,
    reversedBalanceAmount: known ? impact : 0,
    account: await getAccount(db, account.id),
  };
}
