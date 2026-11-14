import { z } from 'zod';
import { ACCOUNT_TYPES } from '@manaclaude/shared';
import { insertStatement, updateStatement } from '../db/table';
import { accountsTable, balanceSnapshotsTable } from '../db/tables';
import { badRequest, conflict, notFound } from '../util/errors';
import { nowIso } from '../util/ids';
import { accountFromRow, accountQuery, currentBalanceSchema } from './accounts';
import { accountStateSql, guardedWrite, versionOf } from './account-writes';

export const accountPatchSchema = z
  .object({
    expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
    name: z.string().trim().min(1).max(100).optional(),
    type: z.enum(ACCOUNT_TYPES).optional(),
    currentBalance: currentBalanceSchema.optional(),
    includeInNetWorth: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 1, 'Supply at least one change.');

export async function accountDetail(db: D1Database, id: string) {
  const row = await db
    .prepare(
      `${accountQuery.replace(
        'SELECT a.*',
        `SELECT (${accountStateSql}) AS state, a.*`,
      )} WHERE a.id = ?1`,
    )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) throw notFound('Account not found.');
  return { account: accountFromRow(row), version: await versionOf(String(row.state)) };
}

export async function patchAccount(
  db: D1Database,
  id: string,
  patch: z.infer<typeof accountPatchSchema>,
  clock: () => Date = () => new Date(),
) {
  const { account, version } = await accountDetail(db, id);
  if (account.connectionId !== null || account.externalId !== null)
    throw conflict('Provider accounts cannot be edited here.', 'account_connected');
  if (patch.expectedVersion !== version)
    throw conflict('Account changed. Reload it before saving.', 'account_changed');
  if (patch.type && (patch.type === 'cash') !== (account.type === 'cash'))
    throw conflict(
      'Cash accounts cannot be converted to or from another kind.',
      'account_kind_conflict',
    );
  if (patch.type && patch.type !== account.type) {
    const investments = await db
      .prepare(
        `SELECT EXISTS(SELECT 1 FROM holdings WHERE account_id = ?1)
      OR EXISTS(SELECT 1 FROM investment_activities WHERE account_id = ?1) AS present`,
      )
      .bind(id)
      .first<number>('present');
    if (investments)
      throw conflict(
        'An account with investment records cannot change kind.',
        'account_kind_conflict',
      );
  }
  const known =
    patch.currentBalance === undefined
      ? (account.manualBalance?.currentKnown ?? true)
      : patch.currentBalance !== null;
  const include = patch.includeInNetWorth ?? (known ? account.includeInNetWorth : false);
  if (!known && include)
    throw badRequest('A known current balance is required for net worth.', 'invalid_body');
  const opening = account.manualBalance?.openingBalance;
  if (opening && patch.currentBalance && opening.date > patch.currentBalance.asOf.slice(0, 10))
    throw badRequest('Opening balance cannot be dated after the current balance.', 'invalid_body');
  // Monotonic even with two edits under the same injected/millisecond clock.
  const now = nowIso(new Date(Math.max(clock().getTime(), Date.parse(account.updatedAt) + 1)));
  const changes = {
    name: patch.name ?? account.name,
    type: patch.type ?? account.type,
    includeInNetWorth: include,
    ...(patch.currentBalance !== undefined
      ? {
          balance: patch.currentBalance?.amount ?? 0,
          balanceAsOf: patch.currentBalance?.asOf ?? now,
          availableBalance: null,
        }
      : {}),
    updatedAt: now,
  };
  const writes = [updateStatement(db, accountsTable, { id }, changes)];
  if (patch.currentBalance !== undefined) {
    writes.push(
      db
        .prepare(
          `INSERT INTO manual_balance_overrides (account_id, current_balance_known, cash_generation)
      VALUES (?, ?, 1) ON CONFLICT(account_id) DO UPDATE SET
      current_balance_known = excluded.current_balance_known,
      cash_generation = manual_balance_overrides.cash_generation + 1`,
        )
        .bind(id, Number(known)),
    );
    if (patch.currentBalance)
      writes.push(
        insertStatement(
          db,
          balanceSnapshotsTable,
          {
            accountId: id,
            date: patch.currentBalance.asOf.slice(0, 10),
            balance: patch.currentBalance.amount,
            currency: account.currency,
          },
          'upsert',
        ),
      );
    // Incrementing the generation retires earlier cash effects in constant row
    // work. No history scan/rewrite is needed to establish an explicit baseline.
  }
  const state = await db.prepare(accountStateSql).bind(id).first<string>('state');
  if (!state || (await versionOf(state)) !== version)
    throw conflict('Account changed. Reload it before saving.', 'account_changed');
  const checks = [{ sql: accountStateSql, id, state }];
  if (patch.type && patch.type !== account.type)
    checks.push({
      sql: `SELECT CASE WHEN EXISTS (SELECT 1 FROM holdings WHERE account_id = ?1)
      OR EXISTS (SELECT 1 FROM investment_activities WHERE account_id = ?1)
      THEN 'blocked' ELSE 'clear' END`,
      id,
      state: 'clear',
    });
  await guardedWrite(db, checks, writes);
  return accountDetail(db, id);
}
