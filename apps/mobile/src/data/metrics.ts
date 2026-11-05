import {
  addDays,
  addMonthsToMonth,
  classifyAccountType,
  convertAmount,
  cumulativeDailySpending,
  daysInMonth,
  firstDayOfMonth,
  lastDayOfMonth,
  monthOf,
  summarizeSpending,
  type CurrencyCode,
  type FinanceDataset,
  type LocalDate,
  type MinorUnits,
  type SpendingSummary,
  type TreatmentContext,
  type YearMonth,
} from '@manaclaude/shared';

/**
 * Derived numbers several screens share (dashboard, net worth, budgets).
 * Pure functions of the dataset; screens call them inside useMemo.
 */

export interface NetWorthBreakdown {
  assets: MinorUnits;
  liabilities: MinorUnits;
  netWorth: MinorUnits;
  currency: CurrencyCode;
}

/** Net worth now, converting every balance with the latest rate. */
export function currentNetWorth(data: FinanceDataset, currency: CurrencyCode): NetWorthBreakdown {
  let assets = 0;
  let liabilities = 0;
  for (const a of data.accounts) {
    if (!a.includeInNetWorth) continue;
    const v = convertAmount(a.balance, a.currency, currency, data.fxRates) ?? 0;
    if (classifyAccountType(a.type) === 'liability') liabilities += v;
    else assets += v;
  }
  return { assets, liabilities, netWorth: assets - liabilities, currency };
}

export interface SeriesPoint {
  date: LocalDate;
  value: MinorUnits;
}

/** Net worth per snapshot date (weekly), converted with the latest rate. */
export function netWorthHistory(data: FinanceDataset, currency: CurrencyCode): SeriesPoint[] {
  const liabilityIds = new Set(
    data.accounts.filter((a) => classifyAccountType(a.type) === 'liability').map((a) => a.id),
  );
  const included = new Set(data.accounts.filter((a) => a.includeInNetWorth).map((a) => a.id));
  const byDate = new Map<LocalDate, number>();
  for (const s of data.balanceHistory) {
    if (!included.has(s.accountId)) continue;
    const v = convertAmount(s.balance, s.currency, currency, data.fxRates) ?? 0;
    byDate.set(s.date, (byDate.get(s.date) ?? 0) + (liabilityIds.has(s.accountId) ? -v : v));
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, value]) => ({ date, value }));
}

export interface MonthSpending {
  month: YearMonth;
  summary: SpendingSummary;
  /** Cumulative spending per day of this month up to today. */
  cumulative: MinorUnits[];
  /** Same for last month, full length. */
  lastMonthCumulative: MinorUnits[];
  /** Last month's spending up to the same day of the month. */
  lastMonthToDate: MinorUnits;
  daysInMonth: number;
  dayOfMonth: number;
}

export function monthSpending(
  data: FinanceDataset,
  ctx: TreatmentContext,
  currency: CurrencyCode,
  today: LocalDate,
): MonthSpending {
  const month = monthOf(today);
  const prev = addMonthsToMonth(month, -1);
  const days = daysInMonth(month);
  const prevDays = daysInMonth(prev);
  const dayOfMonth = Number(today.slice(8, 10));
  const base = { currency, rates: data.fxRates };
  const summary = summarizeSpending(data.transactions, ctx, {
    ...base,
    from: firstDayOfMonth(month),
    to: today,
  });
  const cumulative = cumulativeDailySpending(data.transactions, ctx, {
    ...base,
    from: firstDayOfMonth(month),
    to: today,
    days: dayOfMonth,
  });
  const lastMonthCumulative = cumulativeDailySpending(data.transactions, ctx, {
    ...base,
    from: firstDayOfMonth(prev),
    to: lastDayOfMonth(prev),
    days: prevDays,
  });
  const lastMonthToDate = lastMonthCumulative[Math.min(dayOfMonth, prevDays) - 1] ?? 0;
  return {
    month,
    summary,
    cumulative,
    lastMonthCumulative,
    lastMonthToDate,
    daysInMonth: days,
    dayOfMonth,
  };
}

export interface BudgetLine {
  categoryId: string;
  budgeted: MinorUnits;
  spent: MinorUnits;
  /** Carried in from earlier months when rollover is on. */
  rolledOver: MinorUnits;
  available: MinorUnits;
  rollover: boolean;
}

export interface BudgetMonth {
  month: YearMonth;
  currency: CurrencyCode;
  lines: BudgetLine[];
  totalBudgeted: MinorUnits;
  totalSpent: MinorUnits;
  /** Spending in categories without a budget line. */
  unbudgetedSpent: MinorUnits;
}

/** Category budgets for a month, with simple rollover from the months before it. */
export function budgetMonth(
  data: FinanceDataset,
  ctx: TreatmentContext,
  month: YearMonth,
  currency: CurrencyCode,
  today: LocalDate,
): BudgetMonth {
  const end = lastDayOfMonth(month) < today ? lastDayOfMonth(month) : today;
  const spentIn = (m: YearMonth, to: LocalDate) =>
    summarizeSpending(data.transactions, ctx, {
      from: firstDayOfMonth(m),
      to,
      currency,
      rates: data.fxRates,
    }).byCategory;
  const spent = spentIn(month, end);
  const lines: BudgetLine[] = [];
  const earlierMonths = [...new Set(data.budgets.map((b) => b.month))]
    .filter((m) => m < month)
    .sort();
  const earlierSpent = new Map(earlierMonths.map((m) => [m, spentIn(m, lastDayOfMonth(m))]));
  for (const b of data.budgets.filter((x) => x.month === month)) {
    const budgeted = convertAmount(b.amount, b.currency, currency, data.fxRates) ?? 0;
    let rolledOver = 0;
    if (b.rollover) {
      for (const m of earlierMonths) {
        const prev = data.budgets.find((x) => x.month === m && x.categoryId === b.categoryId);
        if (!prev) continue;
        const prevBudget = convertAmount(prev.amount, prev.currency, currency, data.fxRates) ?? 0;
        rolledOver += prevBudget - (earlierSpent.get(m)?.[b.categoryId] ?? 0);
      }
    }
    const s = spent[b.categoryId] ?? 0;
    lines.push({
      categoryId: b.categoryId,
      budgeted,
      spent: s,
      rolledOver,
      available: budgeted + rolledOver - s,
      rollover: b.rollover,
    });
  }
  const budgetedIds = new Set(lines.map((l) => l.categoryId));
  const unbudgetedSpent = Object.entries(spent)
    .filter(([id]) => !budgetedIds.has(id))
    .reduce((s, [, v]) => s + v, 0);
  return {
    month,
    currency,
    lines,
    totalBudgeted: lines.reduce((s, l) => s + l.budgeted, 0),
    totalSpent: lines.reduce((s, l) => s + l.spent, 0),
    unbudgetedSpent,
  };
}

/** Recurring charges due between today and `days` from now, soonest first. */
export function upcomingRecurring(data: FinanceDataset, today: LocalDate, days: number) {
  const until = addDays(today, days);
  return data.recurring
    .filter(
      (r) =>
        r.status === 'active' &&
        r.nextDueDate !== null &&
        r.nextDueDate >= today &&
        r.nextDueDate <= until,
    )
    .sort((a, b) => (a.nextDueDate ?? '').localeCompare(b.nextDueDate ?? ''));
}
