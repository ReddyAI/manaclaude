import type { Rule } from '@manaclaude/shared';
import {
  checkDraft,
  describeRule,
  draftFromRule,
  emptyDraft,
  newAction,
  newCondition,
  toCondition,
  withEnabled,
  type ConditionDraft,
  type RuleDraft,
} from '../rules';

/** Invented rule in the shape GET /v1/rules sends. */
const RULE: Rule = {
  id: 'rule_ride',
  name: 'Rides',
  enabled: true,
  priority: 50,
  match: 'any',
  conditions: [
    { field: 'name', op: 'contains', value: 'ridely' },
    { field: 'rawName', op: 'regex', value: '^RDLY\\*', caseSensitive: true },
    { field: 'amount', op: 'between', value: [5_00, 80_00] },
    { field: 'accountId', op: 'in', value: ['acc_a', 'acc_b'] },
    { field: 'currency', op: 'equals', value: 'USD' },
  ],
  actions: [
    { type: 'set_category', categoryId: 'cat_rides' },
    { type: 'add_tag', tagId: 'tag_work' },
    { type: 'mark_reviewed' },
  ],
  source: 'user',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

const cond = (d: Partial<ConditionDraft> & Pick<ConditionDraft, 'field'>) =>
  ({ ...newCondition(d.field), ...d }) as ConditionDraft;

describe('conditions', () => {
  it('sends text trimmed, with caseSensitive only when on', () => {
    expect(toCondition(cond({ field: 'name', op: 'contains', text: ' Corner Cafe ' }))).toEqual({
      condition: { field: 'name', op: 'contains', value: 'Corner Cafe' },
    });
    expect(
      toCondition(cond({ field: 'rawName', op: 'starts_with', text: 'POS', caseSensitive: true })),
    ).toEqual({
      condition: { field: 'rawName', op: 'starts_with', value: 'POS', caseSensitive: true },
    });
  });

  it('refuses empty text, more than 200 characters and a broken pattern', () => {
    expect(toCondition(cond({ field: 'name', text: '  ' }))).toEqual({
      problem: 'Type the text to look for.',
    });
    expect(toCondition(cond({ field: 'name', text: 'x'.repeat(201) }))).toHaveProperty('problem');
    expect(toCondition(cond({ field: 'name', op: 'regex', text: 'a(b' }))).toEqual({
      problem: 'This pattern is not valid, so it would never match.',
    });
    expect(toCondition(cond({ field: 'name', op: 'regex', text: '^a|b$' }))).toEqual({
      condition: { field: 'name', op: 'regex', value: '^a|b$' },
    });
  });

  it('sends amounts as whole minor units, never negative, and checks between', () => {
    expect(toCondition(cond({ field: 'amount', op: 'gt', amount: '1,250.5' }))).toEqual({
      condition: { field: 'amount', op: 'gt', value: 1_250_50 },
    });
    expect(toCondition(cond({ field: 'amount', op: 'lt', amount: '-5' }))).toHaveProperty(
      'problem',
    );
    expect(toCondition(cond({ field: 'amount', op: 'equals', amount: '1.234' }))).toHaveProperty(
      'problem',
    );
    expect(toCondition(cond({ field: 'amount', op: 'between', amount: '10', upTo: '20' }))).toEqual(
      { condition: { field: 'amount', op: 'between', value: [10_00, 20_00] } },
    );
    expect(toCondition(cond({ field: 'amount', op: 'between', amount: '20', upTo: '10' }))).toEqual(
      { problem: 'The upper amount is smaller than the lower one.' },
    );
  });

  it('sends one pick as equals and several as in', () => {
    expect(toCondition(cond({ field: 'accountId', values: ['acc_a'] }))).toEqual({
      condition: { field: 'accountId', op: 'equals', value: 'acc_a' },
    });
    expect(toCondition(cond({ field: 'categoryId', values: ['c1', 'c2', 'c1'] }))).toEqual({
      condition: { field: 'categoryId', op: 'in', value: ['c1', 'c2'] },
    });
    expect(toCondition(cond({ field: 'currency', values: [] }))).toEqual({
      problem: 'Pick at least one.',
    });
  });
});

describe('checkDraft', () => {
  const filled = (): RuleDraft => {
    const d = emptyDraft();
    d.name = ' Coffee ';
    d.conditions = [cond({ field: 'name', op: 'contains', text: 'cafe' })];
    d.actions = [{ ...newAction('set_category'), categoryId: 'cat_coffee' } as never];
    return d;
  };

  it('makes exactly the body POST and PUT take', () => {
    expect(checkDraft(filled()).input).toEqual({
      name: 'Coffee',
      enabled: true,
      priority: 100,
      match: 'all',
      conditions: [{ field: 'name', op: 'contains', value: 'cafe' }],
      actions: [{ type: 'set_category', categoryId: 'cat_coffee' }],
    });
  });

  it('says what is missing and makes no body', () => {
    const d = emptyDraft();
    d.priority = '1.5';
    const c = checkDraft(d);
    expect(c.input).toBeNull();
    expect(c.name).toBe('Give the rule a name.');
    expect(c.priority).toMatch(/whole number/);
    expect(Object.values(c.conditions)).toEqual(['Type the text to look for.']);
    expect(Object.values(c.actions)).toEqual(['Pick a category.']);
    const none = { ...filled(), conditions: [], actions: [] };
    expect(checkDraft(none).general).toEqual([
      'Add at least one condition.',
      'Add at least one action.',
    ]);
  });

  it('keeps to 20 conditions and 10 actions', () => {
    const d = filled();
    d.conditions = Array.from({ length: 21 }, () => cond({ field: 'name', text: 'a' }));
    d.actions = Array.from({ length: 11 }, (_, i) => ({
      ...newAction('add_tag'),
      tagId: `tag_${i}`,
    })) as never;
    expect(checkDraft(d).general).toEqual([
      'A rule can have at most 20 conditions.',
      'A rule can have at most 10 actions.',
    ]);
  });

  it('refuses an action the rule already has, which the Worker would ignore', () => {
    const d = filled();
    d.actions = [
      ...d.actions,
      { ...newAction('set_category'), categoryId: 'cat_other' } as never,
      { ...newAction('add_tag'), tagId: 'tag_a' } as never,
      { ...newAction('add_tag'), tagId: 'tag_b' } as never,
      { ...newAction('add_tag'), tagId: 'tag_a' } as never,
    ];
    const c = checkDraft(d);
    expect(c.input).toBeNull();
    expect(Object.values(c.actions)).toHaveLength(2);
  });

  it('accepts a negative priority', () => {
    expect(checkDraft({ ...filled(), priority: '-5' }).input?.priority).toBe(-5);
  });
});

describe('a stored rule', () => {
  it('comes back unchanged through the form', () => {
    const c = checkDraft(draftFromRule(RULE));
    expect(c.input).toEqual(withEnabled(RULE, true));
  });

  it('is sent whole when it is turned off', () => {
    expect(withEnabled(RULE, false)).toEqual({
      name: 'Rides',
      enabled: false,
      priority: 50,
      match: 'any',
      conditions: RULE.conditions,
      actions: RULE.actions,
    });
  });

  it('reads as one line with names from this device', () => {
    const names = {
      account: (id: string) =>
        ({ acc_a: 'Everyday Checking' })[id] ?? 'an account not on this device',
      category: (id: string) => ({ cat_rides: 'Rides' })[id] ?? '?',
      tag: (id: string) => ({ tag_work: 'Work' })[id] ?? '?',
    };
    expect(describeRule(RULE, names)).toBe(
      'If Name contains "ridely" or Bank\'s name matches the pattern "^RDLY\\*" (same case) or Amount between 5.00 and 80.00 or Account is one of Everyday Checking, an account not on this device or Currency is USD: category Rides, tag Work, mark as reviewed',
    );
  });
});
