import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FinanceDataset, Transaction } from '@manaclaude/shared';
import { E2E_TOKEN, executeSql, type LocalWorker } from './worker';

/** What the setup plants on each Worker after the sample seed. Invented data only. */
export const PLANTED = {
  /** A cash wallet in CHF, which the local Worker has no rate for (blocks L and M). */
  chfWallet: 'Zurich wallet',
  /** A CHF cash expense this month (block M). */
  chfExpense: 'Migros',
  /** A CHF budget on "Fees" this month (block M). */
  chfBudgetCategory: 'cat_fees',
  chfBudgetName: 'Fees',
  /** Held in CHF by plant.sql (blocks O and R). */
  chfHolding: 'VTI',
  /** A bill in CHF by plant.sql (block O). */
  chfBill: 'Xfinity internet',
  /** An INR cash expense older than the oldest INR rate (block V). */
  oldInrExpense: 'E2E old chai stall',
  oldInrDaysAgo: 220,
  /** History sources: a Monefy entry the day before the cutoff, and two bank proposals held for review just after it. */
  monefyTea: 'txn_e2e_monefy_tea',
  monefyTeaName: 'E2E Monefy tea',
  reviewKeep: 'hbr_e2e_keep',
  reviewSkip: 'hbr_e2e_skip',
  bankTeaKeep: 'txn_e2e_bank_tea_1',
  bankTeaSkip: 'txn_e2e_bank_tea_2',
  /** Two unlinked halves of a transfer, by plant.sql. */
  transferOut: 'txn_e2e_move_out',
  transferIn: 'txn_e2e_move_in',
} as const;

export function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

async function call<T>(worker: LocalWorker, method: string, route: string, body?: unknown) {
  const res = await fetch(`${worker.url}${route}`, {
    method,
    headers: { authorization: `Bearer ${E2E_TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route} answered ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

/** Seeds the sample data, then plants the rows the specs look for. */
export async function seedAndPlant(runDir: string, worker: LocalWorker): Promise<void> {
  await call(worker, 'POST', '/v1/dev/seed');
  executeSql(runDir, worker.persistDir, path.join(__dirname, '../fixtures/plant.sql'));

  const { account } = await call<{ account: { id: string } }>(worker, 'POST', '/v1/accounts/cash', {
    name: PLANTED.chfWallet,
    currency: 'CHF',
    balance: 12_000,
  });
  await call(worker, 'POST', '/v1/cash', {
    amount: -4_250,
    currency: 'CHF',
    name: PLANTED.chfExpense,
    accountId: account.id,
    date: utcToday(),
  });
  const old = new Date(Date.now() - PLANTED.oldInrDaysAgo * 86_400_000).toISOString().slice(0, 10);
  await call(worker, 'POST', '/v1/cash', {
    amount: -5_000,
    currency: 'INR',
    name: PLANTED.oldInrExpense,
    accountId: 'acc_cash_inr',
    date: old,
  });
  await call(worker, 'PUT', '/v1/budgets', {
    categoryId: PLANTED.chfBudgetCategory,
    month: utcToday().slice(0, 7),
    amount: 10_000,
    currency: 'CHF',
    rollover: false,
    flexType: null,
  });
  await plantBoundary(runDir, worker);
}

const BANK_TYPES = new Set(['checking', 'savings', 'credit_card', 'loan', 'mortgage']);

function shiftDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The cutoff the history specs use: the first day of the month of the
 * earliest bank transaction in a connected bank or card account, so every
 * seeded bank row is on the bank's side of it.
 */
export function historyCutoff(data: FinanceDataset): string {
  const governed = new Set(
    data.accounts.filter((a) => a.connectionId && BANK_TYPES.has(a.type)).map((a) => a.id),
  );
  const first = data.transactions
    .filter((t) => t.source === 'connector' && governed.has(t.accountId))
    .map((t) => t.date)
    .sort()[0]!;
  return `${first.slice(0, 7)}-01`;
}

const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sql = (v: string | null) => (v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`);

/**
 * A Monefy entry the day before the cutoff and two bank rows held for review
 * one and two days after it, as a sync under a policy would leave them (no
 * provider can be called here). The signature is the Worker's own formula,
 * so a kept row counts as a reviewed pair.
 */
async function plantBoundary(runDir: string, worker: LocalWorker): Promise<void> {
  const data = await call<FinanceDataset>(worker, 'GET', '/v1/dataset');
  const cutoff = historyCutoff(data);
  const template = data.transactions.find(
    (t) => t.accountId === 'acc_checking' && t.source === 'connector',
  )!;
  const now = new Date().toISOString();
  const bank = (id: string, externalId: string, date: string): Transaction => ({
    ...template,
    id,
    date,
    amount: -1_234,
    currency: 'USD',
    originalAmount: -1_234,
    originalCurrency: 'USD',
    name: 'E2E Bank tea',
    rawName: 'E2E BANK TEA',
    merchantId: null,
    categoryId: null,
    categorySource: null,
    aiCategoryConfidence: null,
    kind: 'regular',
    pending: false,
    notes: null,
    tagIds: [],
    excluded: false,
    transferLinkId: null,
    receiptId: null,
    recurringId: null,
    splitParentId: null,
    isSplitParent: false,
    reviewed: false,
    reviewedAt: null,
    userEditedFields: [],
    source: 'connector',
    externalId,
    pendingExternalId: null,
    importId: null,
    importFingerprint: null,
    createdAt: now,
    updatedAt: now,
  });
  const review = (id: string, t: Transaction) => {
    const signature = sha256([
      t.accountId,
      t.externalId,
      t.date,
      t.amount,
      t.currency,
      t.pending,
      t.pendingExternalId,
      t.rawName,
    ]);
    return `INSERT INTO history_bank_reviews (id, account_id, external_id, payload, previous, signature, candidate_ids, decision_token, status, updated_at) VALUES (${sql(id)}, ${sql(t.accountId)}, ${sql(t.externalId)}, ${sql(JSON.stringify(t))}, NULL, ${sql(signature)}, ${sql(JSON.stringify([PLANTED.monefyTea]))}, NULL, 'pending', ${sql(now)});`;
  };
  const monefyDate = shiftDays(cutoff, -1);
  const file = path.join(runDir, 'plant-history.sql');
  fs.writeFileSync(
    file,
    [
      `INSERT INTO transactions (id, account_id, date, amount, currency, original_amount, original_currency, name, raw_name, kind, source, external_id, notes, created_at, updated_at) VALUES (${sql(PLANTED.monefyTea)}, 'acc_checking', ${sql(monefyDate)}, -1234, 'USD', -1234, 'USD', ${sql(PLANTED.monefyTeaName)}, 'Tea', 'regular', 'import', 'monefy:e2e-tea', 'Monefy category: Coffee', ${sql(now)}, ${sql(now)});`,
      review(PLANTED.reviewKeep, bank(PLANTED.bankTeaKeep, 'e2e_bank_tea_1', shiftDays(cutoff, 1))),
      review(PLANTED.reviewSkip, bank(PLANTED.bankTeaSkip, 'e2e_bank_tea_2', shiftDays(cutoff, 2))),
      '',
    ].join('\n'),
  );
  executeSql(runDir, worker.persistDir, file);
}
