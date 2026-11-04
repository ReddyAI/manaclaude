import type { Account, BalanceSnapshot } from '../model/account';
import type { LocalDate } from '../model/common';
import type { FinanceDataset } from '../model/dataset';
import { DEFAULT_SETTINGS } from '../model/settings';
import { addDays, todayLocal } from '../dates/dates';
import { SAMPLE_CONNECTOR_SLOTS_USED, sampleAccounts, sampleConnections } from './accounts';
import { SAMPLE_GOALS, sampleBudgets } from './budgets';
import { SAMPLE_CATEGORIES, SAMPLE_CATEGORY_GROUPS, SAMPLE_TAGS } from './categories';
import { sampleFxRates } from './fx';
import { sampleInvestmentData } from './investments';
import { createRandom } from './random';
import { sampleRecurring } from './recurring';
import { sampleTransactionData } from './transactions';

export interface SampleOptions {
  /** Defaults to the device's date, so the sample always looks current. Tests pass a fixed date. */
  today?: LocalDate;
  /** Defaults to now. */
  now?: Date;
}

/** Weekly balances for a year, ending at the current balance. */
function balanceHistory(accounts: readonly Account[], today: LocalDate): BalanceSnapshot[] {
  const rnd = createRandom(5);
  const out: BalanceSnapshot[] = [];
  for (const acc of accounts) {
    const growth =
      acc.type === 'brokerage' || acc.type === 'retirement'
        ? 0.0035
        : acc.type === 'crypto'
          ? 0.008
          : acc.type === 'savings'
            ? 0.003
            : acc.type === 'vehicle'
              ? -0.0025
              : acc.type === 'loan'
                ? -0.0055
                : 0;
    const vol = acc.type === 'crypto' ? 0.06 : acc.type === 'checking' || acc.type === 'credit_card' ? 0.08 : 0.015;
    let value = acc.balance;
    const weekly: number[] = [value];
    for (let w = 1; w <= 52; w += 1) {
      value = value / (1 + growth + (rnd.next() - 0.5) * vol);
      weekly.push(Math.round(value));
    }
    weekly.reverse().forEach((balance, w) => {
      out.push({ accountId: acc.id, date: addDays(today, (w - 52) * 7), balance, currency: acc.currency });
    });
  }
  return out;
}

/** Realistic, made-up data for every screen. Deterministic for a given `today`. */
export function createSampleData(options: SampleOptions = {}): FinanceDataset {
  const nowDate = options.now ?? new Date();
  const today = options.today ?? todayLocal(nowDate);
  const now = nowDate.toISOString();

  const accounts = sampleAccounts(now);
  const investments = sampleInvestmentData(today, now);
  for (const acc of accounts) {
    const held = investments.holdings.filter((h) => h.accountId === acc.id);
    if (held.length > 0) {
      acc.balance = held.reduce((s, h) => s + h.marketValue, 0) + (investments.cashByAccount[acc.id] ?? 0);
    }
  }
  const txData = sampleTransactionData(today, now);

  return {
    accounts,
    balanceHistory: balanceHistory(accounts, today),
    transactions: txData.transactions,
    transferLinks: txData.transferLinks,
    categoryGroups: SAMPLE_CATEGORY_GROUPS,
    categories: SAMPLE_CATEGORIES,
    tags: SAMPLE_TAGS,
    merchants: txData.merchants,
    rules: txData.rules,
    budgets: sampleBudgets(today),
    goals: SAMPLE_GOALS,
    recurring: sampleRecurring(txData.transactions, today),
    securities: investments.securities,
    holdings: investments.holdings,
    taxLots: investments.taxLots,
    activities: investments.activities,
    prices: investments.prices,
    receipts: txData.receipts,
    fxRates: sampleFxRates(today, nowDate),
    connections: sampleConnections(nowDate),
    connectorSlotsUsed: { ...SAMPLE_CONNECTOR_SLOTS_USED },
    settings: { ...DEFAULT_SETTINGS },
  };
}

export { SAMPLE_CATEGORIES, SAMPLE_CATEGORY_GROUPS, SAMPLE_TAGS } from './categories';
export { SAMPLE_SECURITIES, SAMPLE_PRICES } from './investments';
export { createRandom } from './random';
