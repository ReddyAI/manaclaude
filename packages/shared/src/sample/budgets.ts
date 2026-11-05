import type { CategoryBudget, Goal } from '../model/budget';
import type { LocalDate, MinorUnits } from '../model/common';
import { addMonthsToMonth, monthOf } from '../dates/dates';

const MONTHLY: [
  categoryId: string,
  amount: MinorUnits,
  rollover: boolean,
  flex: CategoryBudget['flexType'],
][] = [
  ['cat_rent', 235_000, false, 'fixed'],
  ['cat_utilities', 15_000, false, 'fixed'],
  ['cat_internet', 17_000, false, 'fixed'],
  ['cat_household', 10_000, false, 'flexible'],
  ['cat_groceries', 70_000, true, 'flexible'],
  ['cat_dining', 40_000, false, 'flexible'],
  ['cat_coffee', 8_000, false, 'flexible'],
  ['cat_gas', 16_000, false, 'flexible'],
  ['cat_rideshare', 12_000, false, 'flexible'],
  ['cat_car', 11_000, true, 'non_monthly'],
  ['cat_shopping', 30_000, false, 'flexible'],
  ['cat_subscriptions', 6_000, false, 'fixed'],
  ['cat_entertainment', 10_000, false, 'flexible'],
  ['cat_fitness', 6_000, false, 'fixed'],
  ['cat_travel', 30_000, true, 'non_monthly'],
  ['cat_gifts', 15_000, false, 'flexible'],
  ['cat_health', 8_000, false, 'flexible'],
  ['cat_loan_interest', 7_000, false, 'fixed'],
];

/** Budgets for the current month and the three before it, in USD. */
export function sampleBudgets(today: LocalDate): CategoryBudget[] {
  const current = monthOf(today);
  const out: CategoryBudget[] = [];
  for (let back = 3; back >= 0; back -= 1) {
    const month = addMonthsToMonth(current, -back);
    for (const [categoryId, amount, rollover, flexType] of MONTHLY) {
      out.push({
        id: `bud_${month}_${categoryId}`,
        categoryId,
        month,
        amount,
        currency: 'USD',
        rollover,
        flexType,
      });
    }
  }
  return out;
}

export const SAMPLE_GOALS: Goal[] = [
  {
    id: 'goal_emergency',
    name: 'Emergency fund',
    kind: 'savings',
    targetAmount: 3_000_000,
    currency: 'USD',
    targetDate: '2027-06-30',
    accountIds: ['acc_savings'],
    manualProgress: null,
    color: 'c5',
  },
  {
    id: 'goal_india_home',
    name: 'Home in Hyderabad',
    kind: 'purchase',
    targetAmount: 500_000_000,
    currency: 'INR',
    targetDate: '2029-12-31',
    accountIds: ['acc_nre'],
    manualProgress: null,
    color: 'c3',
  },
  {
    id: 'goal_fire',
    name: 'Financial independence',
    kind: 'retirement',
    targetAmount: 250_000_000,
    currency: 'USD',
    targetDate: '2045-01-01',
    accountIds: ['acc_brokerage', 'acc_401k'],
    manualProgress: null,
    color: 'c7',
  },
  {
    id: 'goal_auto_loan',
    name: 'Pay off the car',
    kind: 'debt_payoff',
    targetAmount: 1_423_690,
    currency: 'USD',
    targetDate: '2028-08-10',
    accountIds: ['acc_auto_loan'],
    manualProgress: null,
    color: 'c10',
  },
];
