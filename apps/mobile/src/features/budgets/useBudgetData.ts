import { useMemo } from 'react';
import {
  computeBudgetMonth,
  convertAmount,
  firstDayOfMonth,
  lastDayOfMonth,
  summarizeSpending,
  type BudgetMonthResult,
  type CurrencyCode,
  type FinanceDataset,
  type LocalDate,
  type TreatmentContext,
  type YearMonth,
} from '@manaclaude/shared';
import { useLookups, useToday } from '../../data/selectors';
import { useFinance } from '../../data/store';
import { useMoneyDisplay } from '../currency/useMoneyDisplay';

/** Spending per category for a month in one currency, rate on each transaction's day. */
export function spentByCategory(
  data: FinanceDataset,
  ctx: TreatmentContext,
  month: YearMonth,
  currency: CurrencyCode,
  today: LocalDate,
) {
  const end = lastDayOfMonth(month) < today ? lastDayOfMonth(month) : today;
  return summarizeSpending(data.transactions, ctx, {
    from: firstDayOfMonth(month),
    to: end,
    currency,
    rates: data.fxRates,
  }).byCategory;
}

export function budgetForMonth(
  data: FinanceDataset,
  ctx: TreatmentContext,
  month: YearMonth,
  currency: CurrencyCode,
  today: LocalDate,
): BudgetMonthResult {
  return computeBudgetMonth({
    month,
    budgets: data.budgets,
    currency,
    spentByCategory: (m) => spentByCategory(data, ctx, m, currency, today),
    budgetAmount: (b) => convertAmount(b.amount, b.currency, currency, data.fxRates) ?? 0,
  });
}

/** Budget numbers for a month in the report currency, and in the second currency in Both mode. */
export function useBudgetData(month: YearMonth) {
  const data = useFinance();
  const lookups = useLookups();
  const today = useToday();
  const display = useMoneyDisplay();
  return useMemo(
    () => display.dual((cur) => budgetForMonth(data, lookups.treatment, month, cur, today)),
    [data, lookups, month, today, display],
  );
}
