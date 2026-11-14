import { snake } from '../db/table';
import { accountsTable, transactionsTable } from '../db/tables';
import { conflict } from '../util/errors';
import { newId, sha256Hex } from '../util/ids';

/** Stable SQL serialization, also evaluated inside the committing batch. */
export const accountStateSql = `SELECT json_array(
  ${Object.keys(accountsTable.columns)
    .map((k) => `a.${snake(k)}`)
    .join(', ')},
  m.opening_balance, m.opening_date, m.current_balance_known, b.current_balance_known, b.cash_generation
) AS state FROM accounts a LEFT JOIN manual_account_details m ON m.account_id = a.id
LEFT JOIN manual_balance_overrides b ON b.account_id = a.id WHERE a.id = ?1`;

export const transactionStateSql = `SELECT json_array(
  ${Object.keys(transactionsTable.columns)
    .map((k) => `t.${snake(k)}`)
    .join(', ')}, e.amount, e.generation
) AS state FROM transactions t LEFT JOIN cash_entry_effects e ON e.transaction_id = t.id WHERE t.id = ?1`;

export const versionOf = (state: string) => sha256Hex(new TextEncoder().encode(state));

export async function guardedWrite(
  db: D1Database,
  checks: { sql: string; id: string; state: string }[],
  statements: D1PreparedStatement[],
): Promise<D1Result[]> {
  const token = newId('guard');
  try {
    return await db.batch([
      ...checks.map((check, i) =>
        db
          .prepare(
            `INSERT INTO account_write_guard (token, valid)
          VALUES (?3, CASE WHEN (${check.sql}) = ?2 THEN 1 ELSE 0 END)`,
          )
          .bind(check.id, check.state, `${token}_${i}`),
      ),
      ...statements,
      ...checks.map((_, i) =>
        db.prepare('DELETE FROM account_write_guard WHERE token = ?').bind(`${token}_${i}`),
      ),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes('CHECK constraint failed: valid = 1')) {
      throw conflict(
        'The account or its related records changed. Reload and review before trying again.',
        'account_changed',
      );
    }
    throw error;
  }
}
