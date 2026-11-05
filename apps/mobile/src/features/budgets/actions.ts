import type { BudgetFlexType, CurrencyCode, MinorUnits, YearMonth } from '@manaclaude/shared';
import { addMonthsToMonth } from '@manaclaude/shared';
import { updateFinance } from '../../data/store';

/** Budget edits (session C). They change the local store now; the backend call comes later. */

export interface BudgetInput {
  categoryId: string;
  month: YearMonth;
  amount: MinorUnits;
  currency: CurrencyCode;
  rollover: boolean;
  flexType: BudgetFlexType | null;
  /** Also apply to every later month that has this category. */
  applyToLaterMonths?: boolean;
}

export const budgetId = (month: YearMonth, categoryId: string) => `bud_${month}_${categoryId}`;

/** Create or change one category's budget for a month. */
export function saveBudget(input: BudgetInput): void {
  const { categoryId, month, applyToLaterMonths = false, ...fields } = input;
  updateFinance((d) => {
    const hasLine = d.budgets.some((b) => b.month === month && b.categoryId === categoryId);
    const budgets = d.budgets.map((b) =>
      b.categoryId === categoryId && (b.month === month || (applyToLaterMonths && b.month > month))
        ? { ...b, ...fields }
        : b,
    );
    if (!hasLine) budgets.push({ id: budgetId(month, categoryId), categoryId, month, ...fields });
    return { ...d, budgets };
  });
}

export function removeBudget(month: YearMonth, categoryId: string): void {
  updateFinance((d) => ({
    ...d,
    budgets: d.budgets.filter((b) => !(b.month === month && b.categoryId === categoryId)),
  }));
}

/** Start a month from the month before it. Lines that already exist are kept. */
export function copyBudgetsFromPreviousMonth(month: YearMonth): number {
  let copied = 0;
  updateFinance((d) => {
    const prev = addMonthsToMonth(month, -1);
    const have = new Set(d.budgets.filter((b) => b.month === month).map((b) => b.categoryId));
    const add = d.budgets
      .filter((b) => b.month === prev && !have.has(b.categoryId))
      .map((b) => ({ ...b, id: budgetId(month, b.categoryId), month }));
    copied = add.length;
    return add.length === 0 ? d : { ...d, budgets: [...d.budgets, ...add] };
  });
  return copied;
}
