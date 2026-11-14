import { z } from 'zod';
import { conflict, notFound } from '../util/errors';
import { nowIso } from '../util/ids';
import { accountFromRow, accountQuery } from './accounts';
import { accountStateSql, guardedWrite, versionOf } from './account-writes';

export const accountDeleteSchema = z
  .object({
    previewToken: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

// Count only; no unbounded JS inventory. The account must be empty. Historical
// import records/files survive; their nullable direct account references detach.
const counts = {
  transactions: 'SELECT count(*) FROM transactions WHERE account_id = ?1',
  balanceSnapshots: 'SELECT count(*) FROM balance_snapshots WHERE account_id = ?1',
  holdings: 'SELECT count(*) FROM holdings WHERE account_id = ?1',
  investmentActivities: 'SELECT count(*) FROM investment_activities WHERE account_id = ?1',
  recurringItems: 'SELECT count(*) FROM recurring_items WHERE account_id = ?1',
  goals:
    'SELECT count(*) FROM goals WHERE EXISTS (SELECT 1 FROM json_each(account_ids) WHERE value = ?1)',
  rules: `SELECT count(*) FROM rules WHERE EXISTS (
    SELECT 1 FROM json_each(conditions) c WHERE json_extract(c.value, '$.field') = 'accountId'
    AND (json_extract(c.value, '$.value') = ?1 OR EXISTS (
      SELECT 1 FROM json_each(c.value, '$.value') WHERE value = ?1)))`,
  imports: 'SELECT count(*) FROM imports WHERE account_id = ?1',
  savedLayouts: 'SELECT count(*) FROM import_mappings WHERE account_id = ?1',
  // A multi-account preview may reference this account only in JSON. A short
  // global commit interlock covers both direct and mapped destinations.
  savingImports: "SELECT count(*) FROM imports WHERE status = 'committing'",
};
export type AccountDeleteCounts = { [K in keyof typeof counts]: number };
export type AccountDeleteBlocker =
  | 'account_connected'
  | 'account_not_empty'
  | 'account_in_use'
  | 'import_in_progress'
  | 'account_delete_too_large';
interface State extends AccountDeleteCounts {
  account: string | null;
  connectionId: string | null;
  externalId: string | null;
  type: string;
  isDefaultCash: number;
  nextCashAccountId: string | null;
}
export const deletionStateSql = `SELECT json_object(
  'account', (${accountStateSql}),
  'connectionId', a.connection_id, 'externalId', a.external_id,
  'type', a.type, 'isDefaultCash', a.is_default_cash,
  'nextCashAccountId', (SELECT id FROM accounts WHERE type = 'cash' AND currency = a.currency
    AND id != a.id AND connection_id IS NULL AND external_id IS NULL
    ORDER BY is_default_cash DESC, created_at, id LIMIT 1),
  ${Object.entries(counts)
    .map(([key, sql]) => `'${key}', (${sql})`)
    .join(',\n')}
) AS state FROM accounts a WHERE a.id = ?1`;

export async function deletionPreview(db: D1Database, id: string) {
  const row = await db
    .prepare(
      `${accountQuery.replace(
        'SELECT a.*',
        `SELECT (${deletionStateSql}) AS state, a.*`,
      )} WHERE a.id = ?1`,
    )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) throw notFound('Account not found.');
  const state = String(row.state);
  const parsed = JSON.parse(state) as State;
  const blockers: AccountDeleteBlocker[] = [];
  if (parsed.connectionId !== null || parsed.externalId !== null)
    blockers.push('account_connected');
  if (parsed.transactions) blockers.push('account_not_empty');
  if (
    parsed.holdings ||
    parsed.investmentActivities ||
    parsed.recurringItems ||
    parsed.goals ||
    parsed.rules
  )
    blockers.push('account_in_use');
  if (parsed.savingImports) blockers.push('import_in_progress');
  if (parsed.balanceSnapshots + parsed.imports + parsed.savedLayouts > 2000)
    blockers.push('account_delete_too_large');
  const countValues = Object.fromEntries(
    Object.keys(counts).map((k) => [k, parsed[k as keyof AccountDeleteCounts]]),
  ) as AccountDeleteCounts;
  return {
    state,
    preview: {
      accountId: id,
      account: accountFromRow(row),
      previewToken: await versionOf(state),
      allowed: blockers.length === 0,
      blockers,
      counts: countValues,
      removes: {
        accounts: 1,
        balanceSnapshots: parsed.balanceSnapshots,
        manualBalance: row.manual_account_id != null || row.balance_override_id != null,
      },
      detaches: { imports: parsed.imports, savedLayouts: parsed.savedLayouts },
      defaultCash:
        parsed.type === 'cash'
          ? {
              wasDefault: parsed.isDefaultCash === 1,
              nextAccountId: parsed.nextCashAccountId,
              createsOnNextUse: parsed.nextCashAccountId === null,
            }
          : null,
    },
  };
}

export async function deleteAccount(
  db: D1Database,
  id: string,
  token: string,
  clock: () => Date = () => new Date(),
) {
  const { preview, state } = await deletionPreview(db, id);
  if (!preview.allowed)
    throw conflict(
      'This account cannot be removed. Read the deletion preview and resolve its blockers first.',
      'account_delete_refused',
    );
  if (token !== preview.previewToken)
    throw conflict(
      'The deletion preview changed. Review a new preview before removing the account.',
      'account_changed',
    );
  const now = nowIso(clock());
  const writes = [
    db
      .prepare(
        `INSERT INTO deleted_manual_accounts (idempotency_key, request_hash, account_id)
      SELECT idempotency_key, request_hash, account_id FROM manual_account_details WHERE account_id = ?`,
      )
      .bind(id),
    db.prepare('DELETE FROM manual_account_details WHERE account_id = ?').bind(id),
    db.prepare('DELETE FROM manual_balance_overrides WHERE account_id = ?').bind(id),
    db.prepare('DELETE FROM cash_entry_effects WHERE account_id = ?').bind(id),
    db.prepare('DELETE FROM balance_snapshots WHERE account_id = ?').bind(id),
    db.prepare('UPDATE imports SET account_id = NULL WHERE account_id = ?').bind(id),
    db.prepare('UPDATE import_mappings SET account_id = NULL WHERE account_id = ?').bind(id),
    db.prepare('DELETE FROM accounts WHERE id = ?').bind(id),
  ];
  if (preview.defaultCash?.wasDefault && preview.defaultCash.nextAccountId) {
    writes.push(
      db
        .prepare(
          `UPDATE accounts SET is_default_cash = (id = ?), updated_at = ?
      WHERE type = 'cash' AND currency = (SELECT currency FROM accounts WHERE id = ?)`,
        )
        .bind(preview.defaultCash.nextAccountId, now, preview.defaultCash.nextAccountId),
    );
  }
  await guardedWrite(db, [{ sql: deletionStateSql, id, state }], writes);
  return { deletedAccountId: id, defaultCash: preview.defaultCash };
}
