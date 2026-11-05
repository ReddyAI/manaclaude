import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MONEY_POLICIES,
  applyRules,
  buildTreatmentContext,
  mergeRespectingUserEdits,
  parseFrankfurter,
  parseOpenExchangeRates,
  reportTreatment,
  type Rule,
} from '../src';
import { CATEGORIES, linkOf, txn } from './fixtures';

const rule = (overrides: Partial<Rule>): Rule => ({
  id: 'r1',
  name: 'r',
  enabled: true,
  priority: 100,
  match: 'all',
  conditions: [{ field: 'rawName', op: 'contains', value: 'coffee' }],
  actions: [{ type: 'set_category', categoryId: 'cat_coffee' }],
  source: 'user',
  createdAt: '',
  updatedAt: '',
  ...overrides,
});

describe('rules', () => {
  it('first matching rule by priority wins each field', () => {
    const t = txn({ amount: -500, rawName: 'BLUE COFFEE CO' });
    const res = applyRules(t, [
      rule({
        id: 'b',
        priority: 200,
        actions: [{ type: 'set_category', categoryId: 'cat_dining' }],
      }),
      rule({ id: 'a', priority: 10 }),
    ]);
    expect(res.transaction).toMatchObject({ categoryId: 'cat_coffee', categorySource: 'rule' });
    expect(res.appliedRuleIds).toEqual(['a']);
  });

  it('supports amount ranges, any-match and disabled rules', () => {
    const t = txn({ amount: -7_500, rawName: 'HARDWARE' });
    const big = rule({
      match: 'any',
      conditions: [
        { field: 'amount', op: 'between', value: [5_000, 10_000] },
        { field: 'rawName', op: 'equals', value: 'nope' },
      ],
      actions: [{ type: 'add_tag', tagId: 'tag_tax' }],
    });
    expect(applyRules(t, [big]).transaction.tagIds).toEqual(['tag_tax']);
    expect(applyRules(t, [{ ...big, enabled: false }]).transaction.tagIds).toEqual([]);
  });

  it('never changes a field the user edited', () => {
    const t = txn({
      amount: -500,
      rawName: 'COFFEE',
      categoryId: 'cat_gifts',
      userEditedFields: ['categoryId'],
    });
    const res = applyRules(t, [rule({})]);
    expect(res.transaction.categoryId).toBe('cat_gifts');
    expect(res.protectedFields).toEqual(['categoryId']);
    const merged = mergeRespectingUserEdits(t, {
      categoryId: 'x',
      categorySource: 'ai',
      amount: -600,
    });
    expect(merged.transaction).toMatchObject({ categoryId: 'cat_gifts', amount: -600 });
    expect(merged.skipped).toEqual(['categoryId']);
  });
});

describe('linked pairs and the count policies', () => {
  it('counts only the outgoing side of a linked contribution when the policy says count', () => {
    const out = txn({ amount: -50_000 });
    const into = txn({ accountId: 'acc_brokerage', amount: 50_000 });
    const link = linkOf(out, into, 'investment_contribution');
    const counted = buildTreatmentContext(
      { ...DEFAULT_MONEY_POLICIES, investmentContributions: 'count' },
      CATEGORIES,
      [link],
    );
    expect(reportTreatment(out, counted).kind).toBe('spending');
    expect(reportTreatment(into, counted).kind).toBe('excluded');
    const byDefault = buildTreatmentContext(DEFAULT_MONEY_POLICIES, CATEGORIES, [link]);
    expect(reportTreatment(out, byDefault).kind).toBe('excluded');
  });
});

describe('FX provider parsing', () => {
  it('reads Open Exchange Rates latest.json for the chosen quotes', () => {
    const rates = parseOpenExchangeRates(
      { timestamp: 1793887200, base: 'USD', rates: { INR: 88.42, ZAR: 18, EUR: 0.92 } },
      ['INR', 'EUR'],
    );
    expect(rates.map((r) => [r.quote, r.rate, r.date, r.source])).toEqual([
      ['INR', 88.42, '2026-11-05', 'openexchangerates'],
      ['EUR', 0.92, '2026-11-05', 'openexchangerates'],
    ]);
    expect(() => parseOpenExchangeRates({}, ['INR'])).toThrow();
  });

  it('rebases a EUR-based Frankfurter series to USD', () => {
    const rates = parseFrankfurter(
      { base: 'EUR', rates: { '2026-10-15': { USD: 1.1, INR: 96.8 } } },
      ['INR'],
    );
    expect(rates).toHaveLength(1);
    expect(rates[0]!.rate).toBeCloseTo(88, 10);
    expect(rates[0]).toMatchObject({ base: 'USD', date: '2026-10-15', source: 'frankfurter_ecb' });
  });
});
