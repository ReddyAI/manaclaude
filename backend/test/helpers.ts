import { applyD1Migrations } from 'cloudflare:test';
import { env as workerEnv } from 'cloudflare:workers';
import {
  DEFAULT_MONEY_POLICIES,
  buildTreatmentContext,
  summarizeSpending,
  type Account,
  type MoneyPolicies,
  type Transaction,
} from '@manaclaude/shared';
import type { Env } from '../src/env';
import { insertStatement, selectAll } from '../src/db/table';
import {
  accountsTable,
  categoriesTable,
  fxRatesTable,
  transactionsTable,
  transferLinksTable,
} from '../src/db/tables';
import { ensureDefaultCategories } from '../src/services/seed';
import { makeTransaction } from '../src/services/transactions';
import { updateSettings } from '../src/services/settings';

export const testEnv = workerEnv as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
export const db = testEnv.DB;

const TABLES = [
  'fx_backfill_progress',
  'fx_backfill_scheduler',
  'manual_account_details',
  'sync_retries',
  'transactions',
  'transfer_links',
  'accounts',
  'balance_snapshots',
  'categories',
  'category_groups',
  'tags',
  'merchants',
  'rules',
  'split_locks',
  'idempotency_keys',
  'budgets',
  'goals',
  'recurring_items',
  'securities',
  'holdings',
  'tax_lots',
  'investment_activities',
  'prices',
  'receipts',
  'fx_rates',
  'imports',
  'import_mappings',
  'ai_examples',
  'alerts',
  'recaps',
  'ai_usage',
  'settings',
  'connections',
  'connector_slots',
  'connection_credentials',
  'link_sessions',
];

/** Migrated, empty database with the default categories. */
export async function freshDb(): Promise<void> {
  await applyD1Migrations(db, testEnv.TEST_MIGRATIONS);
  await db.batch(TABLES.map((t) => db.prepare(`DELETE FROM ${t}`)));
  await ensureDefaultCategories(db);
}

let accountSeq = 0;
export async function addAccount(
  fields: Partial<Account> & Pick<Account, 'type'>,
): Promise<Account> {
  accountSeq += 1;
  const now = '2026-10-01T00:00:00.000Z';
  const account: Account = {
    id: `acc_test_${accountSeq}`,
    name: `${fields.type} ${accountSeq}`,
    institutionName: 'Sample Bank',
    subtype: null,
    currency: 'USD',
    balance: 0,
    balanceAsOf: now,
    availableBalance: null,
    creditLimit: null,
    mask: null,
    connectionId: null,
    externalId: null,
    includeInNetWorth: true,
    hidden: false,
    isDefaultCash: false,
    interestRate: null,
    openedOn: null,
    createdAt: now,
    updatedAt: now,
    ...fields,
  };
  await insertStatement(db, accountsTable, account).run();
  return account;
}

export async function addTxn(
  account: Account,
  fields: Partial<Transaction> & Pick<Transaction, 'amount' | 'date'>,
): Promise<Transaction> {
  const txn = makeTransaction({
    accountId: account.id,
    currency: account.currency,
    source: 'manual',
    rawName: fields.rawName ?? 'TEST',
    ...fields,
  });
  await insertStatement(db, transactionsTable, txn).run();
  return txn;
}

export async function addRate(date: string, quote: string, rate: number): Promise<void> {
  await insertStatement(db, fxRatesTable, {
    base: 'USD',
    quote,
    rate,
    asOf: `${date}T15:00:00.000Z`,
    date,
    source: 'frankfurter_ecb',
  }).run();
}

export async function allTxns(): Promise<Transaction[]> {
  return selectAll(db, transactionsTable, '', [], 'date, created_at');
}

/** Spending summary from what is stored in D1, with the shared policy code. */
export async function spending(
  from: string,
  to: string,
  policies: MoneyPolicies = DEFAULT_MONEY_POLICIES,
  currency = 'USD',
) {
  const [txns, categories, links, rates] = await Promise.all([
    selectAll(db, transactionsTable),
    selectAll(db, categoriesTable),
    selectAll(db, transferLinksTable),
    selectAll(db, fxRatesTable),
  ]);
  const ctx = buildTreatmentContext(policies, categories, links);
  return summarizeSpending(txns, ctx, { from, to, currency, rates });
}

export async function setPolicies(policies: Partial<MoneyPolicies>) {
  await updateSettings(db, { moneyPolicies: policies });
}

export function file(text: string, name: string) {
  return { bytes: new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>, fileName: name };
}
