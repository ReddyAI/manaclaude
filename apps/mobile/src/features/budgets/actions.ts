import type { BudgetFlexType, CurrencyCode, MinorUnits, YearMonth } from '@manaclaude/shared';
import { addMonthsToMonth } from '@manaclaude/shared';
import { api } from '../../data/backend/client';
import { persist } from '../../data/backend/sync';
import { getFinance, updateFinance } from '../../data/store';

/**
 * Budget edits (session C). They change the local store at once and (session
 * E2) save through /v1/budgets when the backend is set up.
 */

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
  const before = getFinance();
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
  void persist('budget', before, () =>
    api('PUT', '/v1/budgets', { categoryId, month, applyToLaterMonths, ...fields }),
  );
}

export function removeBudget(month: YearMonth, categoryId: string): void {
  const before = getFinance();
  updateFinance((d) => ({
    ...d,
    budgets: d.budgets.filter((b) => !(b.month === month && b.categoryId === categoryId)),
  }));
  void persist('budget', before, () =>
    api('DELETE', `/v1/budgets/${month}/${encodeURIComponent(categoryId)}`),
  );
}

/** Start a month from the month before it. Lines that already exist are kept. */
export function copyBudgetsFromPreviousMonth(month: YearMonth): number {
  let copied = 0;
  const before = getFinance();
  updateFinance((d) => {
    const prev = addMonthsToMonth(month, -1);
    const have = new Set(d.budgets.filter((b) => b.month === month).map((b) => b.categoryId));
    const add = d.budgets
      .filter((b) => b.month === prev && !have.has(b.categoryId))
      .map((b) => ({ ...b, id: budgetId(month, b.categoryId), month }));
    copied = add.length;
    return add.length === 0 ? d : { ...d, budgets: [...d.budgets, ...add] };
  });
  if (copied > 0) {
    void persist('budgets', before, () => api('POST', '/v1/budgets/copy-previous', { month }));
  }
  return copied;
}
