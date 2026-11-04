import type { ColorSlot, CurrencyCode, Id, LocalDate, MinorUnits, YearMonth } from './common';

/** Flex budgeting (optional, later): fixed bills, flexible spending, non-monthly costs. */
export type BudgetFlexType = 'fixed' | 'flexible' | 'non_monthly';

/** Budgeted amount for one expense category in one month. */
export interface CategoryBudget {
  id: Id;
  categoryId: Id;
  month: YearMonth;
  /** Positive amount you plan to spend. */
  amount: MinorUnits;
  currency: CurrencyCode;
  /** Carry unspent (or overspent) money into next month. */
  rollover: boolean;
  flexType: BudgetFlexType | null;
}

export interface Goal {
  id: Id;
  name: string;
  kind: 'savings' | 'debt_payoff' | 'retirement' | 'purchase';
  targetAmount: MinorUnits;
  currency: CurrencyCode;
  targetDate: LocalDate | null;
  /** Accounts whose balances count toward the goal. */
  accountIds: Id[];
  /** Used when no account is linked. */
  manualProgress: MinorUnits | null;
  color: ColorSlot;
}
