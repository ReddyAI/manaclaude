import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MONEY_POLICIES,
  buildRecap,
  buildTreatmentContext,
  computeBudgetMonth,
  fireTarget,
  goalProgress,
  monthlyEquivalent,
  monthlyPeriod,
  previousPeriod,
  priceIncrease,
  projectFire,
  realReturn,
  spendingPlan,
  upcomingCharges,
  weeklyPeriod,
  type CategoryBudget,
  type FireInput,
  type Goal,
  type RecurringItem,
} from '../src';
import { createSampleData } from '../src/sample';
import { txn } from './fixtures';

function budget(
  month: string,
  categoryId: string,
  amount: number,
  rollover: boolean,
  flexType: CategoryBudget['flexType'] = null,
): CategoryBudget {
  return {
    id: `${month}_${categoryId}`,
    categoryId,
    month,
    amount,
    currency: 'USD',
    rollover,
    flexType,
  };
}

const run = (
  month: string,
  budgets: CategoryBudget[],
  spent: Record<string, Record<string, number>>,
  rolloverMode?: 'carry_all' | 'carry_unspent',
) =>
  computeBudgetMonth({
    month,
    budgets,
    currency: 'USD',
    spentByCategory: (m) => spent[m] ?? {},
    budgetAmount: (b) => b.amount,
    rolloverMode,
  });

describe('budget rollover', () => {
  const budgets = [
    budget('2026-08', 'food', 50_000, true),
    budget('2026-09', 'food', 50_000, true),
    budget('2026-10', 'food', 50_000, true),
  ];

  it('carries unspent money forward, month after month', () => {
    const spent = {
      '2026-08': { food: 40_000 },
      '2026-09': { food: 45_000 },
      '2026-10': { food: 20_000 },
    };
    const oct = run('2026-10', budgets, spent).lines[0]!;
    // Aug leaves 10_000, Sep adds 5_000 on top of that: 15_000 carried into Oct.
    expect(oct.rolledOver).toBe(15_000);
    expect(oct.available).toBe(50_000 + 15_000 - 20_000);
    expect(run('2026-08', budgets, spent).lines[0]!.rolledOver).toBe(0);
  });

  it('carries overspending as a negative balance by default', () => {
    const spent = { '2026-08': { food: 80_000 }, '2026-09': { food: 10_000 } };
    const sep = run('2026-09', budgets, spent).lines[0]!;
    expect(sep.rolledOver).toBe(-30_000);
    expect(sep.available).toBe(50_000 - 30_000 - 10_000);
  });

  it('can carry only what was left over', () => {
    const spent = { '2026-08': { food: 80_000 } };
    const sep = run('2026-09', budgets, spent, 'carry_unspent').lines[0]!;
    expect(sep.rolledOver).toBe(0);
  });

  it('does not carry when rollover is off or the chain has a gap', () => {
    const off = [budget('2026-08', 'food', 50_000, false), budget('2026-09', 'food', 50_000, true)];
    expect(run('2026-09', off, { '2026-08': { food: 0 } }).lines[0]!.rolledOver).toBe(0);
    const gap = [budget('2026-07', 'food', 50_000, true), budget('2026-09', 'food', 50_000, true)];
    expect(run('2026-09', gap, { '2026-07': { food: 0 } }).lines[0]!.rolledOver).toBe(0);
  });

  it('totals, unbudgeted spending and Flex groups', () => {
    const b = [
      budget('2026-10', 'rent', 200_000, false, 'fixed'),
      budget('2026-10', 'food', 50_000, false, 'flexible'),
      budget('2026-10', 'travel', 30_000, true, 'non_monthly'),
      budget('2026-10', 'misc', 10_000, false, null),
    ];
    const r = run('2026-10', b, {
      '2026-10': { rent: 200_000, food: 60_000, travel: 5_000, misc: 1_000, other: 7_000 },
    });
    expect(r.totalBudgeted).toBe(290_000);
    expect(r.totalSpent).toBe(266_000);
    expect(r.unbudgetedSpent).toBe(7_000);
    expect(r.flex.fixed).toEqual({ budgeted: 200_000, spent: 200_000, available: 0 });
    expect(r.flex.flexible.budgeted).toBe(60_000); // food plus the untyped line
    expect(r.flex.non_monthly.available).toBe(25_000);
  });

  it('keeps a net refund credit (no zero floor)', () => {
    const b = [budget('2026-10', 'food', 50_000, false)];
    const r = run('2026-10', b, { '2026-10': { food: -2_000 } });
    expect(r.lines[0]!.available).toBe(52_000);
  });
});

function recurring(
  over: Partial<RecurringItem> & Pick<RecurringItem, 'id' | 'expectedAmount'>,
): RecurringItem {
  return {
    name: over.id,
    merchantId: null,
    categoryId: null,
    accountId: null,
    kind: 'bill',
    frequency: 'monthly',
    currency: 'USD',
    isVariable: false,
    lastDate: null,
    nextDueDate: null,
    status: 'active',
    decision: null,
    priceHistory: [],
    detectedBy: 'rule',
    aiConfidence: null,
    ...over,
  };
}

describe('Spending Plan', () => {
  it('income minus bills and savings is what you can spend', () => {
    const items = [
      recurring({ id: 'pay', kind: 'income', frequency: 'biweekly', expectedAmount: 400_000 }),
      recurring({ id: 'rent', categoryId: 'rent', expectedAmount: -200_000 }),
      recurring({ id: 'ins', categoryId: 'car', frequency: 'semiannual', expectedAmount: -60_000 }),
      recurring({ id: 'old', expectedAmount: -99_999, status: 'cancelled' }),
    ];
    const plan = spendingPlan({
      recurring: items,
      savings: 100_000,
      spentByCategory: { rent: 200_000, car: 60_000, dining: 30_000, groceries: 50_000 },
      convert: (a) => a,
    });
    expect(plan.income).toBe(Math.round((400_000 * 26) / 12));
    expect(plan.bills).toBe(200_000 + 10_000);
    expect(plan.leftToSpend).toBe(plan.income - 210_000 - 100_000);
    expect(plan.flexibleSpent).toBe(80_000);
    expect(plan.remaining).toBe(plan.leftToSpend - 80_000);
  });

  it('converts non-USD items into the report currency', () => {
    const plan = spendingPlan({
      recurring: [recurring({ id: 'sip', currency: 'INR', expectedAmount: -8_800_000 })],
      savings: 0,
      spentByCategory: {},
      convert: (a, c) => (c === 'INR' ? Math.round(a / 88) : a),
    });
    expect(plan.bills).toBe(100_000);
  });
});

describe('goal progress', () => {
  const goal: Goal = {
    id: 'g',
    name: 'Fund',
    kind: 'savings',
    targetAmount: 1_000_000,
    currency: 'USD',
    targetDate: '2027-10-31',
    accountIds: ['a', 'b'],
    manualProgress: null,
    color: 'c1',
  };
  it('adds linked balances and works out the monthly amount needed', () => {
    const p = goalProgress(goal, (id) => (id === 'a' ? 300_000 : 100_000), '2026-10');
    expect(p.current).toBe(400_000);
    expect(p.fraction).toBeCloseTo(0.4);
    expect(p.monthlyNeeded).toBe(50_000); // 600_000 over 12 months
  });
  it('counts a debt payoff as the amount paid down', () => {
    const p = goalProgress(
      { ...goal, kind: 'debt_payoff', accountIds: ['loan'] },
      () => 250_000,
      '2026-10',
    );
    expect(p.current).toBe(750_000);
  });
  it('uses manual progress when no account is linked and stops at reached goals', () => {
    const p = goalProgress(
      { ...goal, accountIds: [], manualProgress: 1_200_000 },
      () => 0,
      '2026-10',
    );
    expect(p.fraction).toBeCloseTo(1.2);
    expect(p.monthlyNeeded).toBeNull();
  });
});

describe('recurring helpers', () => {
  it('turns every frequency into a monthly amount', () => {
    expect(monthlyEquivalent({ expectedAmount: -1_200, frequency: 'annual' })).toBe(-100);
    expect(monthlyEquivalent({ expectedAmount: 1_200, frequency: 'weekly' })).toBe(5_200);
  });

  it('flags a price increase with the yearly cost', () => {
    const item = recurring({
      id: 'nflx',
      kind: 'subscription',
      expectedAmount: -1_799,
      priceHistory: [
        { date: '2026-07-01', amount: -1_549 },
        { date: '2026-08-01', amount: -1_549 },
        { date: '2026-09-01', amount: -1_799 },
        { date: '2026-10-01', amount: -1_799 },
      ],
    });
    const inc = priceIncrease(item)!;
    expect(inc).toMatchObject({
      from: 1_549,
      to: 1_799,
      yearlyImpact: 250 * 12,
      since: '2026-09-01',
    });
    expect(inc.pct).toBeCloseTo(250 / 1549);
  });

  it('ignores price drops, variable bills, income and flat prices', () => {
    const hist = (a: number, b: number) => [
      { date: '2026-09-01', amount: a },
      { date: '2026-10-01', amount: b },
    ];
    expect(
      priceIncrease(recurring({ id: 'a', expectedAmount: -500, priceHistory: hist(-900, -500) })),
    ).toBeNull();
    expect(
      priceIncrease(
        recurring({
          id: 'b',
          expectedAmount: -900,
          isVariable: true,
          priceHistory: hist(-500, -900),
        }),
      ),
    ).toBeNull();
    expect(
      priceIncrease(
        recurring({ id: 'c', expectedAmount: 900, kind: 'income', priceHistory: hist(500, 900) }),
      ),
    ).toBeNull();
    expect(
      priceIncrease(recurring({ id: 'd', expectedAmount: -500, priceHistory: hist(-500, -500) })),
    ).toBeNull();
  });

  it('lists upcoming charges soonest first and repeats weekly items', () => {
    const items = [
      recurring({ id: 'rent', nextDueDate: '2026-11-10', expectedAmount: -1 }),
      recurring({ id: 'wk', frequency: 'weekly', nextDueDate: '2026-11-06', expectedAmount: -1 }),
      recurring({ id: 'late', nextDueDate: '2026-12-25', expectedAmount: -1 }),
      recurring({ id: 'off', status: 'paused', nextDueDate: '2026-11-07', expectedAmount: -1 }),
    ];
    const out = upcomingCharges(items, '2026-11-05', 14);
    expect(out.map((x) => `${x.item.id}@${x.date}`)).toEqual([
      'wk@2026-11-06',
      'rent@2026-11-10',
      'wk@2026-11-13',
    ]);
  });
});

describe('FIRE projection', () => {
  const base: FireInput = {
    currentSavings: 0,
    monthlyContribution: 500_000,
    annualReturn: 0.05,
    inflation: 0.05,
    currentAge: 30,
    retirementAge: 40,
    annualExpenses: 4_000_000,
    withdrawalRate: 0.04,
  };

  it('sizes the target from expenses and the withdrawal rate', () => {
    expect(fireTarget(4_000_000, 0.04)).toBe(100_000_000);
    expect(fireTarget(4_000_000, 0.04, 5_000)).toBe(5_000);
    expect(realReturn(0.07, 0.03)).toBeCloseTo(0.038835, 5);
  });

  it('with zero real return the balance is just the money saved', () => {
    const r = projectFire(base);
    expect(r.realReturn).toBeCloseTo(0, 12);
    expect(r.balanceAtRetirement).toBe(500_000 * 120);
    expect(r.points[10]!.real).toBe(60_000_000);
    expect(r.points[10]!.age).toBe(40);
    expect(r.onTrack).toBe(false);
    expect(r.yearsToTarget).toBeCloseTo(100_000_000 / 500_000 / 12, 1);
  });

  it('reaches the target earlier with a higher return', () => {
    const low = projectFire({ ...base, annualReturn: 0.06 });
    const high = projectFire({ ...base, annualReturn: 0.1 });
    expect(high.yearsToTarget!).toBeLessThan(low.yearsToTarget!);
    expect(high.fireAge!).toBeLessThan(low.fireAge!);
  });

  it('higher inflation lowers the real return and delays the target', () => {
    const calm = projectFire({ ...base, annualReturn: 0.08, inflation: 0.02 });
    const hot = projectFire({ ...base, annualReturn: 0.08, inflation: 0.06 });
    expect(hot.realReturn).toBeLessThan(calm.realReturn);
    expect(hot.yearsToTarget!).toBeGreaterThan(calm.yearsToTarget!);
  });

  it('nominal values are the real values grown by inflation', () => {
    const r = projectFire({ ...base, annualReturn: 0.08, inflation: 0.03 });
    const p = r.points[5]!;
    expect(Math.abs(p.nominal - p.real * 1.03 ** 5)).toBeLessThanOrEqual(1);
  });

  it('the required monthly saving lands exactly on the target at retirement', () => {
    const r = projectFire({
      ...base,
      currentSavings: 2_000_000,
      annualReturn: 0.07,
      inflation: 0.03,
    });
    const again = projectFire({
      ...base,
      currentSavings: 2_000_000,
      annualReturn: 0.07,
      inflation: 0.03,
      monthlyContribution: r.requiredMonthlyContribution,
    });
    expect(again.balanceAtRetirement).toBeGreaterThanOrEqual(again.target - 5);
    expect(again.onTrack).toBe(true);
  });

  it('is already there when savings cover the target', () => {
    const r = projectFire({ ...base, currentSavings: 200_000_000 });
    expect(r.yearsToTarget).toBe(0);
    expect(r.requiredMonthlyContribution).toBe(0);
    expect(r.onTrack).toBe(true);
  });

  it('reports no date when the target is out of reach', () => {
    const r = projectFire({ ...base, monthlyContribution: 0, maxYears: 20 });
    expect(r.yearsToTarget).toBeNull();
    expect(r.fireAge).toBeNull();
  });

  it('a manual target replaces the expenses-based one', () => {
    const r = projectFire({ ...base, targetOverride: 6_000_000 });
    expect(r.target).toBe(6_000_000);
    expect(r.yearsToTarget).toBeCloseTo(1, 0);
    expect(r.onTrack).toBe(true);
    expect(r.sustainableIncome).toBe(Math.round(r.balanceAtRetirement * 0.04));
  });
});

describe('recaps', () => {
  const policies = DEFAULT_MONEY_POLICIES;

  it('summarises a week against the week before, ignoring transfers', () => {
    const ctx = buildTreatmentContext(policies, [], []);
    const data = {
      ...createSampleData({ today: '2026-11-05', now: new Date('2026-11-05T12:00:00Z') }),
      transactions: [
        txn({ amount: -10_000, date: '2026-11-03', categoryId: 'cat_dining' }),
        txn({ amount: -5_000, date: '2026-11-04', categoryId: 'cat_groceries' }),
        txn({ amount: -8_000, date: '2026-10-30', categoryId: 'cat_dining' }),
        txn({ amount: -500_000, date: '2026-11-02', kind: 'transfer' }),
        txn({ amount: 300_000, date: '2026-11-01', categoryId: 'cat_paycheck' }),
      ],
    };
    const recap = buildRecap(data, {
      period: weeklyPeriod('2026-11-05'),
      currency: 'USD',
      ctx: buildTreatmentContext(policies, data.categories, data.transferLinks),
      now: new Date('2026-11-05T12:00:00Z'),
    });
    void ctx;
    expect(recap.periodStart).toBe('2026-10-30');
    expect(recap.spending).toBe(15_000 + 8_000);
    expect(recap.income).toBe(300_000);
    expect(recap.previousSpending).toBe(0);
    expect(recap.topCategories[0]).toMatchObject({ categoryId: 'cat_dining', amount: 18_000 });
    expect(recap.biggestTransactions[0]!.amount).toBe(10_000);
    expect(recap.source).toBe('local');
    expect(recap.headline).toContain('$230');
    expect(recap.headline).toContain('over the last 7 days');
  });

  it('builds a month in review for a past month and stops the current one at today', () => {
    const data = createSampleData({ today: '2026-11-05', now: new Date('2026-11-05T12:00:00Z') });
    const ctx = buildTreatmentContext(
      data.settings.moneyPolicies,
      data.categories,
      data.transferLinks,
    );
    const oct = monthlyPeriod('2026-10', '2026-11-05');
    expect(oct).toMatchObject({ start: '2026-10-01', end: '2026-10-31' });
    expect(monthlyPeriod('2026-11', '2026-11-05').end).toBe('2026-11-05');
    const recap = buildRecap(data, { period: oct, currency: 'USD', ctx });
    expect(recap.spending).toBeGreaterThan(0);
    expect(recap.topCategories.length).toBeGreaterThan(0);
    expect(recap.highlights.length).toBeGreaterThan(1);
    expect(recap.netWorthChange).not.toBeNull();
    // Every top category amount is positive and sorted high to low.
    const amounts = recap.topCategories.map((c) => c.amount);
    expect([...amounts].sort((a, b) => b - a)).toEqual(amounts);
  });

  it('compares a half-finished month with the same days of the month before', () => {
    expect(previousPeriod(monthlyPeriod('2026-11', '2026-11-05'))).toEqual({
      start: '2026-10-01',
      end: '2026-10-05',
    });
    expect(previousPeriod(monthlyPeriod('2026-10', '2026-11-05'))).toEqual({
      start: '2026-09-01',
      end: '2026-09-30',
    });
    expect(previousPeriod(weeklyPeriod('2026-11-05'))).toEqual({
      start: '2026-10-23',
      end: '2026-10-29',
    });
    // 31 days into a 30-day month stays inside it.
    expect(previousPeriod(monthlyPeriod('2026-10', '2026-10-31')).end).toBe('2026-09-30');
  });

  it('shows the same spending in INR using each transaction day rate', () => {
    const data = createSampleData({ today: '2026-11-05', now: new Date('2026-11-05T12:00:00Z') });
    const ctx = buildTreatmentContext(
      data.settings.moneyPolicies,
      data.categories,
      data.transferLinks,
    );
    const usd = buildRecap(data, { period: weeklyPeriod('2026-11-05'), currency: 'USD', ctx });
    const inr = buildRecap(data, { period: weeklyPeriod('2026-11-05'), currency: 'INR', ctx });
    const ratio = inr.spending / usd.spending;
    expect(ratio).toBeGreaterThan(70);
    expect(ratio).toBeLessThan(110);
  });
});
