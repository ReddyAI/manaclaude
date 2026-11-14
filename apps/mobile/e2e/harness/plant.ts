import path from 'node:path';
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
}
