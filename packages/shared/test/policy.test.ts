import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MONEY_POLICIES,
  buildSplitChildren,
  buildTreatmentContext,
  reportTreatment,
  summarizeSpending,
  validateSplit,
  type FxRate,
  type MoneyPolicies,
  type Transaction,
  type TransferLink,
} from '../src';
import { CATEGORIES, linkOf, txn } from './fixtures';

const RATES: FxRate[] = [
  { base: 'USD', quote: 'INR', rate: 88, asOf: '2026-10-01T00:00:00.000Z', date: '2026-10-01', source: 'sample' },
];

function summarize(txns: Transaction[], links: TransferLink[] = [], policies: MoneyPolicies = DEFAULT_MONEY_POLICIES) {
  const ctx = buildTreatmentContext(policies, CATEGORIES, links);
  return summarizeSpending(txns, ctx, { from: '2026-10-01', to: '2026-10-31', currency: 'USD', rates: RATES });
}

// research/sure/rea.md build check 1.
describe('check 1: no double counting of transfers and card payments', () => {
  it('a $200 purchase and its $200 card payment count as $200 of spending', () => {
    const purchase = txn({ accountId: 'acc_card', amount: -20_000, categoryId: 'cat_shopping' });
    const payOut = txn({ accountId: 'acc_checking', amount: -20_000, kind: 'card_payment' });
    const payIn = txn({ accountId: 'acc_card', amount: 20_000, kind: 'card_payment' });
    const link = linkOf(payOut, payIn, 'card_payment');
    const s = summarize([purchase, payOut, payIn], [link]);
    expect(s.spending).toBe(20_000);
    expect(s.income).toBe(0);
  });

  it('a linked transfer is excluded from spending and income even with a spending category', () => {
    const out = txn({ amount: -50_000, categoryId: 'cat_shopping' });
    const into = txn({ accountId: 'acc_savings', amount: 50_000, categoryId: 'cat_shopping' });
    const link = linkOf(out, into, 'transfer');
    const s = summarize([out, into], [link]);
    expect(s.spending).toBe(0);
    expect(s.income).toBe(0);
  });

  it('a rejected or merely suggested link does not hide a regular transaction', () => {
    const out = txn({ amount: -5_000, categoryId: 'cat_dining' });
    const into = txn({ accountId: 'acc_savings', amount: 5_000, categoryId: 'cat_paycheck' });
    for (const status of ['rejected', 'suggested'] as const) {
      const link = linkOf(out, into, 'transfer', status);
      const s = summarize([out, into], [link]);
      expect(s.spending).toBe(5_000);
      expect(s.income).toBe(5_000);
    }
  });

  it('an unlinked transfer kind is still excluded by policy', () => {
    const atm = txn({ amount: -20_000, kind: 'transfer' });
    expect(summarize([atm]).spending).toBe(0);
  });

  it('a split parent is replaced by its children', () => {
    const parent = txn({ amount: -10_000, categoryId: 'cat_shopping', isSplitParent: true });
    const a = txn({ amount: -6_000, categoryId: 'cat_shopping', splitParentId: parent.id });
    const b = txn({ amount: -4_000, categoryId: 'cat_dining', splitParentId: parent.id });
    const s = summarize([parent, a, b]);
    expect(s.spending).toBe(10_000);
    expect(s.byCategory).toEqual({ cat_shopping: 6_000, cat_dining: 4_000 });
  });

  it('a cross-currency transfer (USD to NRE) never shows up as spending or income', () => {
    const out = txn({ amount: -200_000, kind: 'transfer' });
    const into = txn({ accountId: 'acc_nre', currency: 'INR', amount: 17_600_000, kind: 'transfer' });
    const link = linkOf(out, into, 'transfer');
    expect(summarize([out, into], [link])).toMatchObject({ spending: 0, income: 0 });
  });
});

// research/sure/rea.md build check 5.
describe('check 5: refund and investment-contribution policies are explicit', () => {
  it('refunds reduce their category in the month they post, with no zero floor', () => {
    const buy = txn({ amount: -10_000, categoryId: 'cat_shopping' });
    const refund = txn({ amount: 3_000, categoryId: 'cat_shopping' });
    expect(summarize([buy, refund]).byCategory.cat_shopping).toBe(7_000);
    // A refund for something bought last month: this month's category goes negative.
    const lateRefund = txn({ amount: 5_000, categoryId: 'cat_shopping' });
    const s = summarize([lateRefund]);
    expect(s.byCategory.cat_shopping).toBe(-5_000);
    expect(s.spending).toBe(-5_000);
    expect(s.income).toBe(0);
  });

  it('the zero-floor policy is available when chosen', () => {
    const lateRefund = txn({ amount: 5_000, categoryId: 'cat_shopping' });
    const s = summarize([lateRefund], [], { ...DEFAULT_MONEY_POLICIES, categoryFloor: 'zero' });
    expect(s.byCategory.cat_shopping).toBe(0);
  });

  it('refunds can be reported as income instead', () => {
    const refund = txn({ amount: 3_000, categoryId: 'cat_shopping' });
    const s = summarize([refund], [], { ...DEFAULT_MONEY_POLICIES, refunds: 'count_as_income' });
    expect(s).toMatchObject({ spending: 0, income: 3_000 });
  });

  it('brokerage and retirement contributions are not spending by default', () => {
    const contribution = txn({ amount: -50_000, kind: 'investment_contribution' });
    const ctx = buildTreatmentContext(DEFAULT_MONEY_POLICIES, CATEGORIES, []);
    expect(reportTreatment(contribution, ctx)).toEqual({ kind: 'excluded', reason: 'investment_contribution' });
    const counted = summarize([contribution], [], { ...DEFAULT_MONEY_POLICIES, investmentContributions: 'count' });
    expect(counted.spending).toBe(50_000);
  });

  it('loan principal is a transfer and interest is spending', () => {
    const parent = txn({ amount: -45_218, isSplitParent: true });
    const principal = txn({ amount: -38_940, kind: 'loan_payment', splitParentId: parent.id });
    const interest = txn({ amount: -6_278, categoryId: 'cat_loan_interest', splitParentId: parent.id });
    const s = summarize([parent, principal, interest]);
    expect(s.spending).toBe(6_278);
    expect(s.byCategory).toEqual({ cat_loan_interest: 6_278 });
  });

  it('positive amounts outside expense categories are income', () => {
    const pay = txn({ amount: 421_538, categoryId: 'cat_paycheck' });
    const unknown = txn({ amount: 1_000, categoryId: null });
    expect(summarize([pay, unknown]).income).toBe(422_538);
  });

  it('pending rows count unless the policy excludes them', () => {
    const pending = txn({ amount: -2_000, categoryId: 'cat_dining', pending: true });
    expect(summarize([pending]).spending).toBe(2_000);
    expect(summarize([pending], [], { ...DEFAULT_MONEY_POLICIES, pendingTransactions: 'exclude' }).spending).toBe(0);
  });

  it('converts foreign-currency spending with the rate on its date', () => {
    const inrCash = txn({ accountId: 'acc_cash_inr', currency: 'INR', amount: -880_000, categoryId: 'cat_dining' });
    expect(summarize([inrCash]).spending).toBe(10_000);
  });
});

// research/sure/rea.md build check 3 (pure part; atomic writes are tested in backend/).
describe('check 3: splits balance exactly', () => {
  const parent = txn({ amount: -10_000, categoryId: 'cat_shopping' });

  it('accepts $60 + $40 for a $100 transaction', () => {
    expect(validateSplit(parent, [
      { amount: -6_000, categoryId: 'cat_shopping' },
      { amount: -4_000, categoryId: 'cat_dining' },
    ])).toEqual({ ok: true });
  });

  it('rejects $60 + $50, wrong signs, a single line and non-integers', () => {
    expect(validateSplit(parent, [{ amount: -6_000, categoryId: null }, { amount: -5_000, categoryId: null }]).ok).toBe(false);
    expect(validateSplit(parent, [{ amount: -11_000, categoryId: null }, { amount: 1_000, categoryId: null }]).ok).toBe(false);
    expect(validateSplit(parent, [{ amount: -10_000, categoryId: null }]).ok).toBe(false);
    expect(validateSplit(parent, [{ amount: -5_000.5, categoryId: null }, { amount: -4_999.5, categoryId: null }]).ok).toBe(false);
  });

  it('refuses to split pending rows, transfers and existing splits', () => {
    const lines = [{ amount: -6_000, categoryId: null }, { amount: -4_000, categoryId: null }];
    expect(validateSplit({ ...parent, pending: true }, lines).ok).toBe(false);
    expect(validateSplit({ ...parent, transferLinkId: 'tl_1' }, lines).ok).toBe(false);
    expect(validateSplit({ ...parent, isSplitParent: true }, lines).ok).toBe(false);
    expect(validateSplit({ ...parent, splitParentId: 'x' }, lines).ok).toBe(false);
  });

  it('builds children that keep the total and point at the parent', () => {
    const { parent: p, children } = buildSplitChildren(
      parent,
      [{ amount: -6_000, categoryId: 'cat_shopping' }, { amount: -4_000, categoryId: 'cat_dining' }],
      (i) => `${parent.id}_s${i}`,
      '2026-10-16T00:00:00.000Z',
    );
    expect(p.isSplitParent).toBe(true);
    expect(children.map((c) => c.splitParentId)).toEqual([parent.id, parent.id]);
    expect(children.reduce((s, c) => s + c.amount, 0)).toBe(parent.amount);
    expect(summarize([p, ...children]).spending).toBe(10_000);
  });
});
