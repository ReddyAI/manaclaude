import { z } from 'zod';
import {
  ACCOUNT_TYPES,
  parseDateWithFormat,
  type Account,
  type BalanceSnapshot,
} from '@manaclaude/shared';
import { fromRow, insertStatement } from '../db/table';
import { accountsTable, balanceSnapshotsTable } from '../db/tables';
import { conflict, notFound } from '../util/errors';
import { newId, nowIso, sha256Hex } from '../util/ids';

const amount = z.number().int().refine(Number.isSafeInteger, 'Use whole, safe minor units.');
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => parseDateWithFormat(v, 'YYYY-MM-DD') !== null, 'Use a valid calendar date.');

export const currentBalanceSchema = z
  .object({ amount, asOf: z.iso.datetime().transform((v) => new Date(v).toISOString()) })
  .strict()
  .nullable();

/** Backend-local contract. Shared/mobile adoption belongs to Claude. */
export const manualAccountSchema = z
  .object({
    idempotencyKey: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9_-]+$/),
    name: z.string().trim().min(1).max(100),
    type: z.enum(ACCOUNT_TYPES).refine((v) => v !== 'cash', 'Use /v1/accounts/cash for cash.'),
    currency: z.string().regex(/^[A-Z]{3}$/),
    // AccountSubtype intentionally permits provider/custom labels. Do not infer a type from it.
    subtype: z.string().trim().min(1).max(100).nullable().default(null),
    openingBalance: z.object({ amount, date }).strict().nullable().default(null),
    // Required, including explicit null: omission must never mean a real zero balance.
    currentBalance: currentBalanceSchema,
    includeInNetWorth: z.boolean().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.currentBalance === null && v.includeInNetWorth === true) {
      ctx.addIssue({
        code: 'custom',
        path: ['includeInNetWorth'],
        message: 'A current balance is required to include this account in net worth.',
      });
    }
    if (
      v.openingBalance &&
      v.currentBalance &&
      v.openingBalance.date > v.currentBalance.asOf.slice(0, 10)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['openingBalance', 'date'],
        message: 'Opening balance cannot be dated after the current balance.',
      });
    }
  })
  .transform((v) => ({
    ...v,
    includeInNetWorth: v.includeInNetWorth ?? v.currentBalance !== null,
  }));

export type CreateManualAccountRequest = z.input<typeof manualAccountSchema>;
export interface ManualBalanceInfo {
  currentKnown: boolean;
  openingBalance: { amount: number; date: string } | null;
}
export interface AccountWithManualBalance extends Account {
  /** Present after manual creation or an explicit current-balance edit. */
  manualBalance?: ManualBalanceInfo;
}
export interface CreateManualAccountResponse {
  account: AccountWithManualBalance;
  replayed: boolean;
}

export const accountQuery = `SELECT a.*, m.account_id AS manual_account_id,
  b.account_id AS balance_override_id,
  COALESCE(b.current_balance_known, m.current_balance_known) AS current_balance_known,
  m.opening_balance, m.opening_date
  FROM accounts a LEFT JOIN manual_account_details m ON m.account_id = a.id
  LEFT JOIN manual_balance_overrides b ON b.account_id = a.id`;

export function accountFromRow(row: Record<string, unknown>): AccountWithManualBalance {
  const account: AccountWithManualBalance = fromRow(accountsTable, row);
  if (row.manual_account_id != null || row.balance_override_id != null) {
    account.manualBalance = {
      currentKnown: row.current_balance_known === 1,
      openingBalance:
        row.opening_balance === null
          ? null
          : { amount: Number(row.opening_balance), date: String(row.opening_date) },
    };
  }
  return account;
}

/** One query, including metadata; no additional query per account. */
export async function listAccounts(db: D1Database): Promise<AccountWithManualBalance[]> {
  const rows = await db.prepare(`${accountQuery} ORDER BY a.name`).all<Record<string, unknown>>();
  return rows.results.map(accountFromRow);
}

export async function getAccount(db: D1Database, id: string): Promise<AccountWithManualBalance> {
  const row = await db
    .prepare(`${accountQuery} WHERE a.id = ?`)
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) throw notFound('Account not found.');
  return accountFromRow(row);
}

async function replay(
  db: D1Database,
  key: string,
  hash: string,
): Promise<CreateManualAccountResponse | null> {
  const saved = await db
    .prepare(
      `SELECT account_id, request_hash FROM manual_account_details WHERE idempotency_key = ?1
       UNION ALL SELECT account_id, request_hash FROM deleted_manual_accounts WHERE idempotency_key = ?1`,
    )
    .bind(key)
    .first<{ account_id: string; request_hash: string }>();
  if (!saved) return null;
  if (saved.request_hash !== hash) {
    throw conflict(
      'This creation key was already used for different account details. Reuse the original request or start a new creation with a new key.',
      'idempotency_conflict',
    );
  }
  const row = await db
    .prepare(`${accountQuery} WHERE a.id = ?`)
    .bind(saved.account_id)
    .first<Record<string, unknown>>();
  if (!row)
    throw conflict('The previously created account is no longer available.', 'account_missing');
  // Return current state without overwriting any changes made after creation.
  return { account: accountFromRow(row), replayed: true };
}

/** Account, provenance, retry key and explicit snapshots commit or roll back together. */
export async function createManualAccount(
  db: D1Database,
  input: z.output<typeof manualAccountSchema>,
  clock: () => Date = () => new Date(),
): Promise<CreateManualAccountResponse> {
  const { idempotencyKey, ...details } = input;
  const hash = await sha256Hex(new TextEncoder().encode(JSON.stringify(details)));
  const existing = await replay(db, idempotencyKey, hash);
  if (existing) return existing;

  const now = nowIso(clock());
  const account: AccountWithManualBalance = {
    id: newId('acc'),
    name: input.name,
    institutionName: null,
    type: input.type,
    subtype: input.subtype,
    currency: input.currency,
    // The shared Account model requires a number/time. These are placeholders when unknown.
    balance: input.currentBalance?.amount ?? 0,
    balanceAsOf: input.currentBalance?.asOf ?? now,
    availableBalance: null,
    creditLimit: null,
    mask: null,
    connectionId: null,
    externalId: null,
    includeInNetWorth: input.includeInNetWorth,
    hidden: false,
    isDefaultCash: false,
    interestRate: null,
    openedOn: input.openingBalance?.date ?? null,
    createdAt: now,
    updatedAt: now,
    manualBalance: {
      currentKnown: input.currentBalance !== null,
      openingBalance: input.openingBalance,
    },
  };
  // The existing snapshot model has one reading per day: current wins on the same day.
  const snapshots = new Map<string, BalanceSnapshot>();
  for (const reading of [
    input.openingBalance,
    input.currentBalance && {
      amount: input.currentBalance.amount,
      date: input.currentBalance.asOf.slice(0, 10),
    },
  ]) {
    if (reading) {
      snapshots.set(reading.date, {
        accountId: account.id,
        date: reading.date,
        balance: reading.amount,
        currency: account.currency,
      });
    }
  }
  try {
    await db.batch([
      insertStatement(db, accountsTable, account),
      db
        .prepare(
          `INSERT INTO manual_account_details
           (account_id, idempotency_key, request_hash, opening_balance, opening_date, current_balance_known)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          account.id,
          idempotencyKey,
          hash,
          input.openingBalance?.amount ?? null,
          input.openingBalance?.date ?? null,
          input.currentBalance === null ? 0 : 1,
        ),
      ...[...snapshots.values()].map((s) => insertStatement(db, balanceSnapshotsTable, s)),
    ]);
  } catch (error) {
    // A concurrent request may have won the unique key. A different payload still conflicts.
    const winner = await replay(db, idempotencyKey, hash);
    if (winner) return winner;
    throw error;
  }
  return { account, replayed: false };
}
