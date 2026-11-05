import type { BudgetFlexType, CategoryBudget } from '../model/budget';
import type { Goal } from '../model/budget';
import type { CurrencyCode, Id, MinorUnits, YearMonth } from '../model/common';
import type { RecurringItem } from '../model/recurring';
import { addMonthsToMonth } from '../dates/dates';
import { monthlyEquivalent } from './recurring';

/**
 * Budget maths: monthly lines with rollover, Flex groups and the Spending Plan.
 * Pure; the caller supplies spending per category already converted into the
 * report currency (with each transaction's own-day rate) and a converter for
 * the budget amounts themselves.
 */

export interface BudgetLine {
  categoryId: Id;
  flexType: BudgetFlexType | null;
  /** This month's budget. */
  budgeted: MinorUnits;
  spent: MinorUnits;
  /** Carried in from the previous month when rollover is on. May be negative (overspent). */
  rolledOver: MinorUnits;
  /** budgeted + rolledOver - spent. */
  available: MinorUnits;
  rollover: boolean;
}

export interface FlexTotals {
  budgeted: MinorUnits;
  spent: MinorUnits;
  available: MinorUnits;
}

export interface BudgetMonthResult {
  month: YearMonth;
  currency: CurrencyCode;
  lines: BudgetLine[];
  totalBudgeted: MinorUnits;
  totalSpent: MinorUnits;
  /** Spending in categories without a budget line this month. */
  unbudgetedSpent: MinorUnits;
  /** Totals per Flex group; lines without a type count as flexible. */
  flex: Record<BudgetFlexType, FlexTotals>;
}

export interface BudgetMonthInput {
  month: YearMonth;
  budgets: readonly CategoryBudget[];
  currency: CurrencyCode;
  /** Spending per category id for a month, in `currency`. Called for earlier months too. */
  spentByCategory: (month: YearMonth) => Record<Id, MinorUnits>;
  /** A budget's amount in `currency`. */
  budgetAmount: (budget: CategoryBudget) => MinorUnits;
  /**
   * 'carry_all' carries overspending forward as a negative balance (default).
   * 'carry_unspent' only carries money that was left over.
   */
  rolloverMode?: 'carry_all' | 'carry_unspent';
}

/**
 * Rollover chains month to month: a month's carry-in is the previous month's
 * available amount, but only when that month had a line for the category with
 * rollover on. A gap or a rollover-off month starts the chain again.
 */
export function computeBudgetMonth(input: BudgetMonthInput): BudgetMonthResult {
  const { month, budgets, currency } = input;
  const mode = input.rolloverMode ?? 'carry_all';
  const lineOf = new Map<string, CategoryBudget>();
  for (const b of budgets) lineOf.set(`${b.month}|${b.categoryId}`, b);
  const spentCache = new Map<YearMonth, Record<Id, MinorUnits>>();
  const spentIn = (m: YearMonth) => {
    let s = spentCache.get(m);
    if (!s) {
      s = input.spentByCategory(m);
      spentCache.set(m, s);
    }
    return s;
  };
  const earliest = budgets.reduce<YearMonth>((e, b) => (b.month < e ? b.month : e), month);

  const availableAt = (categoryId: Id, m: YearMonth): { available: number; rolled: number } => {
    const b = lineOf.get(`${m}|${categoryId}`);
    if (!b) return { available: 0, rolled: 0 };
    let rolled = 0;
    if (m > earliest) {
      const prevMonth = addMonthsToMonth(m, -1);
      const prev = lineOf.get(`${prevMonth}|${categoryId}`);
      if (prev?.rollover) {
        const carry = availableAt(categoryId, prevMonth).available;
        rolled = mode === 'carry_unspent' ? Math.max(0, carry) : carry;
      }
    }
    const spent = spentIn(m)[categoryId] ?? 0;
    return { available: input.budgetAmount(b) + rolled - spent, rolled };
  };

  const spentNow = spentIn(month);
  const lines: BudgetLine[] = [];
  for (const b of budgets) {
    if (b.month !== month) continue;
    const { available, rolled } = availableAt(b.categoryId, month);
    lines.push({
      categoryId: b.categoryId,
      flexType: b.flexType,
      budgeted: input.budgetAmount(b),
      spent: spentNow[b.categoryId] ?? 0,
      rolledOver: rolled,
      available,
      rollover: b.rollover,
    });
  }
  const budgetedIds = new Set(lines.map((l) => l.categoryId));
  const unbudgetedSpent = Object.entries(spentNow)
    .filter(([id]) => !budgetedIds.has(id))
    .reduce((s, [, v]) => s + v, 0);
  const flex: Record<BudgetFlexType, FlexTotals> = {
    fixed: { budgeted: 0, spent: 0, available: 0 },
    flexible: { budgeted: 0, spent: 0, available: 0 },
    non_monthly: { budgeted: 0, spent: 0, available: 0 },
  };
  for (const l of lines) {
    const t = flex[l.flexType ?? 'flexible'];
    t.budgeted += l.budgeted;
    t.spent += l.spent;
    t.available += l.available;
  }
  return {
    month,
    currency,
    lines,
    totalBudgeted: lines.reduce((s, l) => s + l.budgeted, 0),
    totalSpent: lines.reduce((s, l) => s + l.spent, 0),
    unbudgetedSpent,
    flex,
  };
}

export interface SpendingPlanInput {
  recurring: readonly RecurringItem[];
  /** Planned saving per month, positive. */
  savings: MinorUnits;
  /** Spending this month per category, report currency. */
  spentByCategory: Record<Id, MinorUnits>;
  /** Recurring amount in report currency (positive = per-month cost or income). */
  convert: (amount: MinorUnits, currency: CurrencyCode) => MinorUnits;
}

export interface SpendingPlan {
  /** Expected monthly income from recurring income. */
  income: MinorUnits;
  /** Bills and subscriptions per month. */
  bills: MinorUnits;
  savings: MinorUnits;
  /** income - bills - savings: the money left for everything else. */
  leftToSpend: MinorUnits;
  /** Spent this month outside the bill categories. */
  flexibleSpent: MinorUnits;
  /** leftToSpend - flexibleSpent. Negative means over plan. */
  remaining: MinorUnits;
  /** Category ids that bills and subscriptions are filed under. */
  billCategoryIds: Id[];
}

/** Spending Plan: income minus bills and savings is what you can spend. */
export function spendingPlan(input: SpendingPlanInput): SpendingPlan {
  let income = 0;
  let bills = 0;
  const billCategories = new Set<Id>();
  for (const r of input.recurring) {
    if (r.status !== 'active') continue;
    const perMonth = input.convert(monthlyEquivalent(r), r.currency);
    if (r.kind === 'income') income += Math.max(0, perMonth);
    else if (r.kind === 'bill' || r.kind === 'subscription') {
      bills += Math.max(0, -perMonth);
      if (r.categoryId) billCategories.add(r.categoryId);
    }
  }
  const flexibleSpent = Object.entries(input.spentByCategory)
    .filter(([id]) => !billCategories.has(id))
    .reduce((s, [, v]) => s + v, 0);
  const leftToSpend = income - bills - input.savings;
  return {
    income,
    bills,
    savings: input.savings,
    leftToSpend,
    flexibleSpent,
    remaining: leftToSpend - flexibleSpent,
    billCategoryIds: [...billCategories],
  };
}

export interface GoalProgress {
  current: MinorUnits;
  target: MinorUnits;
  /** 0 to 1 (can pass 1 when the goal is exceeded). */
  fraction: number;
  /** Needed each month to reach the target by its date; null without a date or already reached. */
  monthlyNeeded: MinorUnits | null;
}

/**
 * Progress toward a goal, in the goal's currency. `balanceOf` returns an
 * account's balance in that currency. Debt payoff counts what has been paid
 * down (target minus what is still owed).
 */
export function goalProgress(
  goal: Goal,
  balanceOf: (accountId: Id) => MinorUnits,
  todayMonth: YearMonth,
): GoalProgress {
  const linked = goal.accountIds.reduce((s, id) => s + balanceOf(id), 0);
  const raw =
    goal.accountIds.length === 0
      ? (goal.manualProgress ?? 0)
      : goal.kind === 'debt_payoff'
        ? goal.targetAmount - linked
        : linked;
  const current = Math.max(0, raw);
  const fraction = goal.targetAmount > 0 ? current / goal.targetAmount : 0;
  let monthlyNeeded: MinorUnits | null = null;
  if (goal.targetDate && current < goal.targetAmount) {
    const [ty, tm] = goal.targetDate.slice(0, 7).split('-').map(Number);
    const [cy, cm] = todayMonth.split('-').map(Number);
    const months = (ty! - cy!) * 12 + (tm! - cm!);
    if (months > 0) monthlyNeeded = Math.ceil((goal.targetAmount - current) / months);
  }
  return { current, target: goal.targetAmount, fraction, monthlyNeeded };
}
