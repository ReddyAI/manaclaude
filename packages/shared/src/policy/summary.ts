import type { CurrencyCode, Id, LocalDate, MinorUnits } from '../model/common';
import type { FxRate } from '../model/fx';
import type { Transaction } from '../model/transaction';
import { convertAmount } from '../fx/convert';
import { reportTreatment, type TreatmentContext } from './treatment';

export const UNCATEGORIZED = 'uncategorized';

export interface SpendingSummary {
  currency: CurrencyCode;
  /** Total spending (purchases minus refunds). Can be negative. */
  spending: MinorUnits;
  income: MinorUnits;
  /** income - spending */
  net: MinorUnits;
  /** Spending per category id ("uncategorized" for none). Refunds can make a value negative. */
  byCategory: Record<Id, MinorUnits>;
  /** Transactions that counted. */
  counted: number;
  /** Transactions skipped because no FX rate was available. */
  missingRate: number;
}

export interface SummaryOptions {
  from: LocalDate;
  to: LocalDate;
  /** Report currency. Amounts are converted with the rate on each transaction's date. */
  currency: CurrencyCode;
  rates: readonly FxRate[];
  /** Only these accounts (default: all). */
  accountIds?: ReadonlySet<Id>;
}

/**
 * Spending and income for a date range, by category, in one currency.
 * Uses reportTreatment so transfers, card payments, contributions and split
 * parents are never double counted.
 */
export function summarizeSpending(
  transactions: readonly Transaction[],
  ctx: TreatmentContext,
  options: SummaryOptions,
): SpendingSummary {
  const byCategory: Record<Id, MinorUnits> = {};
  let spending = 0;
  let income = 0;
  let counted = 0;
  let missingRate = 0;

  for (const txn of transactions) {
    if (txn.date < options.from || txn.date > options.to) continue;
    if (options.accountIds && !options.accountIds.has(txn.accountId)) continue;
    const t = reportTreatment(txn, ctx);
    if (t.kind === 'excluded') continue;
    const converted = convertAmount(txn.amount, txn.currency, options.currency, options.rates, {
      mode: 'on',
      date: txn.date,
    });
    if (converted === null) {
      missingRate += 1;
      continue;
    }
    counted += 1;
    if (t.kind === 'spending') {
      const key = txn.categoryId ?? UNCATEGORIZED;
      byCategory[key] = (byCategory[key] ?? 0) - converted;
      spending -= converted;
    } else {
      income += converted;
    }
  }

  if (ctx.policies.categoryFloor === 'zero') {
    spending = 0;
    for (const [key, value] of Object.entries(byCategory)) {
      const floored = Math.max(0, value);
      byCategory[key] = floored;
      spending += floored;
    }
  }

  return {
    currency: options.currency,
    spending,
    income,
    net: income - spending,
    byCategory,
    counted,
    missingRate,
  };
}

/**
 * Cumulative spending per day of a range, for the "this month vs last month"
 * chart. Index 0 is `from`.
 */
export function cumulativeDailySpending(
  transactions: readonly Transaction[],
  ctx: TreatmentContext,
  options: SummaryOptions & { days: number },
): MinorUnits[] {
  const perDay = new Array<number>(options.days).fill(0);
  const fromTime = Date.parse(`${options.from}T00:00:00Z`);
  for (const txn of transactions) {
    if (txn.date < options.from || txn.date > options.to) continue;
    if (options.accountIds && !options.accountIds.has(txn.accountId)) continue;
    const t = reportTreatment(txn, ctx);
    if (t.kind !== 'spending') continue;
    const converted = convertAmount(txn.amount, txn.currency, options.currency, options.rates, {
      mode: 'on',
      date: txn.date,
    });
    if (converted === null) continue;
    const idx = Math.round((Date.parse(`${txn.date}T00:00:00Z`) - fromTime) / 86_400_000);
    if (idx >= 0 && idx < options.days) perDay[idx] = (perDay[idx] ?? 0) - converted;
  }
  let running = 0;
  return perDay.map((v) => (running += v));
}
