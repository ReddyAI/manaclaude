import {
  parseMoneyInput,
  type Rule,
  type RuleAction,
  type RuleCondition,
  type RuleInput,
  type TransactionKind,
} from '@manaclaude/shared';

/**
 * What the rule form can hold, and how it becomes exactly what POST and PUT
 * /v1/rules accept. Every condition and action the Worker's schema allows is
 * here, and nothing else:
 *
 * - name or the bank's name: contains, equals, starts with, regex (1 to 200
 *   characters), optionally matching upper and lower case exactly
 * - amount: equals, over, under, between (whole minor units)
 * - account, category, currency: equals one, or is one of several
 * - set category, rename, set kind, add a tag, mark reviewed, leave out
 *
 * At least 1 and at most 20 conditions, 1 to 10 actions, a name of 1 to 200
 * characters, a whole-number priority.
 */

export const RULE_NAME_MAX = 200;
export const TEXT_MAX = 200;
export const MAX_CONDITIONS = 20;
export const MAX_ACTIONS = 10;
export const DEFAULT_PRIORITY = 100;

export type TextField = 'name' | 'rawName';
export type TextOp = 'contains' | 'equals' | 'starts_with' | 'regex';
export type AmountOp = 'equals' | 'gt' | 'lt' | 'between';
export type ListField = 'accountId' | 'categoryId' | 'currency';
export type ConditionField = TextField | 'amount' | ListField;

export type ConditionDraft =
  | { key: string; field: TextField; op: TextOp; text: string; caseSensitive: boolean }
  /** `amount` is the value, or the lower end for between; `upTo` the upper end. Major units as typed. */
  | { key: string; field: 'amount'; op: AmountOp; amount: string; upTo: string }
  | { key: string; field: ListField; values: string[] };

export type ActionType = RuleAction['type'];

export type ActionDraft =
  | { key: string; type: 'set_category'; categoryId: string | null }
  | { key: string; type: 'set_name'; name: string }
  | { key: string; type: 'set_kind'; kind: TransactionKind }
  | { key: string; type: 'add_tag'; tagId: string | null }
  | { key: string; type: 'mark_reviewed' }
  | { key: string; type: 'exclude' };

export interface RuleDraft {
  name: string;
  enabled: boolean;
  /** As typed: a whole number. */
  priority: string;
  match: 'all' | 'any';
  conditions: ConditionDraft[];
  actions: ActionDraft[];
}

export const CONDITION_FIELDS: { field: ConditionField; label: string }[] = [
  { field: 'name', label: 'Name' },
  { field: 'rawName', label: "Bank's name" },
  { field: 'amount', label: 'Amount' },
  { field: 'accountId', label: 'Account' },
  { field: 'categoryId', label: 'Category' },
  { field: 'currency', label: 'Currency' },
];

export const TEXT_OPS: { op: TextOp; label: string }[] = [
  { op: 'contains', label: 'contains' },
  { op: 'equals', label: 'is exactly' },
  { op: 'starts_with', label: 'starts with' },
  { op: 'regex', label: 'matches the pattern' },
];

export const AMOUNT_OPS: { op: AmountOp; label: string }[] = [
  { op: 'equals', label: 'is exactly' },
  { op: 'gt', label: 'is over' },
  { op: 'lt', label: 'is under' },
  { op: 'between', label: 'is between' },
];

export const ACTION_TYPES: { type: ActionType; label: string }[] = [
  { type: 'set_category', label: 'Set the category' },
  { type: 'set_name', label: 'Rename' },
  { type: 'set_kind', label: 'Set the kind' },
  { type: 'add_tag', label: 'Add a tag' },
  { type: 'mark_reviewed', label: 'Mark as reviewed' },
  { type: 'exclude', label: 'Leave out of reports and budgets' },
];

export const KINDS: { kind: TransactionKind; label: string }[] = [
  { kind: 'regular', label: 'Regular' },
  { kind: 'transfer', label: 'Transfer between my accounts' },
  { kind: 'card_payment', label: 'Card payment' },
  { kind: 'loan_payment', label: 'Loan payment' },
  { kind: 'investment_contribution', label: 'Investment contribution' },
];

const FIELD_LABEL = Object.fromEntries(CONDITION_FIELDS.map((f) => [f.field, f.label])) as Record<
  ConditionField,
  string
>;
const KIND_LABEL = Object.fromEntries(KINDS.map((k) => [k.kind, k.label])) as Record<
  TransactionKind,
  string
>;

let keySeq = 0;
/** A key for one row of the form (React lists only; never sent). */
export function formKey(): string {
  keySeq += 1;
  return `k${keySeq}`;
}

export function newCondition(field: ConditionField): ConditionDraft {
  const key = formKey();
  if (field === 'name' || field === 'rawName')
    return { key, field, op: 'contains', text: '', caseSensitive: false };
  if (field === 'amount') return { key, field, op: 'gt', amount: '', upTo: '' };
  return { key, field, values: [] };
}

export function newAction(type: ActionType): ActionDraft {
  const key = formKey();
  switch (type) {
    case 'set_category':
      return { key, type, categoryId: null };
    case 'set_name':
      return { key, type, name: '' };
    case 'set_kind':
      return { key, type, kind: 'regular' };
    case 'add_tag':
      return { key, type, tagId: null };
    case 'mark_reviewed':
    case 'exclude':
      return { key, type };
  }
}

export function emptyDraft(): RuleDraft {
  return {
    name: '',
    enabled: true,
    priority: String(DEFAULT_PRIORITY),
    match: 'all',
    conditions: [newCondition('name')],
    actions: [newAction('set_category')],
  };
}

/** Rule amounts carry no currency: they are typed and shown with two decimals, as for USD and INR. */
const AMOUNT_UNIT = 'USD';

export function amountText(minor: number): string {
  return (minor / 100).toFixed(2);
}

function conditionDraft(c: RuleCondition): ConditionDraft {
  const key = formKey();
  switch (c.field) {
    case 'name':
    case 'rawName':
      return { key, field: c.field, op: c.op, text: c.value, caseSensitive: !!c.caseSensitive };
    case 'amount':
      return c.op === 'between'
        ? {
            key,
            field: 'amount',
            op: 'between',
            amount: amountText(c.value[0]),
            upTo: amountText(c.value[1]),
          }
        : { key, field: 'amount', op: c.op, amount: amountText(c.value), upTo: '' };
    case 'accountId':
    case 'categoryId':
    case 'currency':
      return {
        key,
        field: c.field,
        values: Array.isArray(c.value) ? [...c.value] : [c.value],
      };
  }
}

function actionDraft(a: RuleAction): ActionDraft {
  return { ...a, key: formKey() } as ActionDraft;
}

export function draftFromRule(rule: Rule): RuleDraft {
  return {
    name: rule.name,
    enabled: rule.enabled,
    priority: String(rule.priority),
    match: rule.match,
    conditions: rule.conditions.map(conditionDraft),
    actions: rule.actions.map(actionDraft),
  };
}

function parseAmount(text: string): number | 'empty' | 'bad' | 'negative' {
  if (!text.trim()) return 'empty';
  const v = parseMoneyInput(text, AMOUNT_UNIT);
  if (v === null) return 'bad';
  if (v < 0) return 'negative';
  return v;
}

function amountProblem(r: ReturnType<typeof parseAmount>, label: string): string | null {
  if (r === 'empty') return `Type ${label}.`;
  if (r === 'bad')
    return `${label[0]!.toUpperCase()}${label.slice(1)} is not a number with at most two decimals.`;
  if (r === 'negative')
    return 'Type the size of the amount without a minus sign: rules compare amounts going out and coming in alike.';
  return null;
}

/** Why the pattern cannot be used, or null. The Worker treats a broken pattern as never matching. */
export function patternProblem(text: string, caseSensitive: boolean): string | null {
  try {
    new RegExp(text, caseSensitive ? '' : 'i');
    return null;
  } catch {
    return 'This pattern is not valid, so it would never match.';
  }
}

export type ConditionResult = { condition: RuleCondition } | { problem: string };

export function toCondition(d: ConditionDraft): ConditionResult {
  switch (d.field) {
    case 'name':
    case 'rawName': {
      const value = d.op === 'regex' ? d.text : d.text.trim();
      if (!value.trim()) return { problem: 'Type the text to look for.' };
      if (value.length > TEXT_MAX)
        return { problem: `Use at most ${TEXT_MAX} characters (${value.length} now).` };
      if (d.op === 'regex') {
        const p = patternProblem(value, d.caseSensitive);
        if (p) return { problem: p };
      }
      return {
        condition: {
          field: d.field,
          op: d.op,
          value,
          ...(d.caseSensitive ? { caseSensitive: true } : {}),
        },
      };
    }
    case 'amount': {
      const low = parseAmount(d.amount);
      const lowProblem = amountProblem(low, d.op === 'between' ? 'the lower amount' : 'an amount');
      if (lowProblem) return { problem: lowProblem };
      if (d.op !== 'between')
        return { condition: { field: 'amount', op: d.op, value: low as number } };
      const high = parseAmount(d.upTo);
      const highProblem = amountProblem(high, 'the upper amount');
      if (highProblem) return { problem: highProblem };
      if ((high as number) < (low as number))
        return { problem: 'The upper amount is smaller than the lower one.' };
      return {
        condition: { field: 'amount', op: 'between', value: [low as number, high as number] },
      };
    }
    case 'accountId':
    case 'categoryId':
    case 'currency': {
      const values = [...new Set(d.values)];
      if (values.length === 0) return { problem: 'Pick at least one.' };
      return values.length === 1
        ? { condition: { field: d.field, op: 'equals', value: values[0]! } }
        : { condition: { field: d.field, op: 'in', value: values } };
    }
  }
}

export type ActionResult = { action: RuleAction } | { problem: string };

export function toAction(d: ActionDraft): ActionResult {
  switch (d.type) {
    case 'set_category':
      return d.categoryId
        ? { action: { type: 'set_category', categoryId: d.categoryId } }
        : { problem: 'Pick a category.' };
    case 'set_name': {
      const name = d.name.trim();
      if (!name) return { problem: 'Type the new name.' };
      if (name.length > TEXT_MAX)
        return { problem: `Use at most ${TEXT_MAX} characters (${name.length} now).` };
      return { action: { type: 'set_name', name } };
    }
    case 'set_kind':
      return { action: { type: 'set_kind', kind: d.kind } };
    case 'add_tag':
      return d.tagId ? { action: { type: 'add_tag', tagId: d.tagId } } : { problem: 'Pick a tag.' };
    case 'mark_reviewed':
      return { action: { type: 'mark_reviewed' } };
    case 'exclude':
      return { action: { type: 'exclude' } };
  }
}

/**
 * Action types a rule may hold once. The Worker uses only the first of each
 * (and the first add_tag per tag), so a second one would do nothing.
 */
export function actionTaken(actions: readonly ActionDraft[], type: ActionType): boolean {
  return type !== 'add_tag' && actions.some((a) => a.type === type);
}

export interface DraftCheck {
  input: RuleInput | null;
  name: string | null;
  priority: string | null;
  /** By form key. */
  conditions: Record<string, string>;
  actions: Record<string, string>;
  /** Problems with the rule as a whole. */
  general: string[];
}

/** The request body, or every reason it cannot be sent yet. */
export function checkDraft(draft: RuleDraft): DraftCheck {
  const out: DraftCheck = {
    input: null,
    name: null,
    priority: null,
    conditions: {},
    actions: {},
    general: [],
  };
  const name = draft.name.trim();
  if (!name) out.name = 'Give the rule a name.';
  else if (name.length > RULE_NAME_MAX)
    out.name = `Use at most ${RULE_NAME_MAX} characters (${name.length} now).`;
  const p = draft.priority.trim();
  const priority = /^-?\d+$/.test(p) ? Number(p) : NaN;
  if (!Number.isSafeInteger(priority)) out.priority = 'Type a whole number, for example 100.';
  if (draft.conditions.length === 0) out.general.push('Add at least one condition.');
  if (draft.conditions.length > MAX_CONDITIONS)
    out.general.push(`A rule can have at most ${MAX_CONDITIONS} conditions.`);
  if (draft.actions.length === 0) out.general.push('Add at least one action.');
  if (draft.actions.length > MAX_ACTIONS)
    out.general.push(`A rule can have at most ${MAX_ACTIONS} actions.`);
  const conditions: RuleCondition[] = [];
  for (const d of draft.conditions) {
    const r = toCondition(d);
    if ('problem' in r) out.conditions[d.key] = r.problem;
    else conditions.push(r.condition);
  }
  const actions: RuleAction[] = [];
  const seen = new Set<string>();
  for (const d of draft.actions) {
    const r = toAction(d);
    if ('problem' in r) {
      out.actions[d.key] = r.problem;
      continue;
    }
    const slot = r.action.type === 'add_tag' ? `tag:${r.action.tagId}` : r.action.type;
    if (seen.has(slot)) {
      out.actions[d.key] = 'The rule already does this; a second one would be ignored.';
      continue;
    }
    seen.add(slot);
    actions.push(r.action);
  }
  const ok =
    !out.name &&
    !out.priority &&
    out.general.length === 0 &&
    Object.keys(out.conditions).length === 0 &&
    Object.keys(out.actions).length === 0;
  if (ok)
    out.input = { name, enabled: draft.enabled, priority, match: draft.match, conditions, actions };
  return out;
}

/** The rule's body for PUT, from a stored rule, with `enabled` changed (the on and off switch). */
export function withEnabled(rule: Rule, enabled: boolean): RuleInput {
  return {
    name: rule.name,
    enabled,
    priority: rule.priority,
    match: rule.match,
    conditions: rule.conditions,
    actions: rule.actions,
  };
}

export interface Names {
  account(id: string): string;
  category(id: string): string;
  tag(id: string): string;
}

const TEXT_OP_LABEL = Object.fromEntries(TEXT_OPS.map((o) => [o.op, o.label])) as Record<
  TextOp,
  string
>;

function list(values: string[], name: (v: string) => string): string {
  return values.map(name).join(', ');
}

export function describeCondition(c: RuleCondition, names: Names): string {
  switch (c.field) {
    case 'name':
    case 'rawName':
      return `${FIELD_LABEL[c.field]} ${TEXT_OP_LABEL[c.op]} "${c.value}"${c.caseSensitive ? ' (same case)' : ''}`;
    case 'amount':
      if (c.op === 'between')
        return `Amount between ${amountText(c.value[0])} and ${amountText(c.value[1])}`;
      return `Amount ${{ equals: 'is exactly', gt: 'over', lt: 'under' }[c.op]} ${amountText(c.value)}`;
    case 'accountId':
    case 'categoryId':
    case 'currency': {
      const values = Array.isArray(c.value) ? c.value : [c.value];
      const name =
        c.field === 'accountId'
          ? names.account
          : c.field === 'categoryId'
            ? names.category
            : (v: string) => v;
      return values.length === 1
        ? `${FIELD_LABEL[c.field]} is ${name(values[0]!)}`
        : `${FIELD_LABEL[c.field]} is one of ${list(values, name)}`;
    }
  }
}

export function describeAction(a: RuleAction, names: Names): string {
  switch (a.type) {
    case 'set_category':
      return `category ${names.category(a.categoryId)}`;
    case 'set_name':
      return `rename to "${a.name}"`;
    case 'set_kind':
      return `kind ${KIND_LABEL[a.kind]}`;
    case 'add_tag':
      return `tag ${names.tag(a.tagId)}`;
    case 'mark_reviewed':
      return 'mark as reviewed';
    case 'exclude':
      return 'leave out of reports and budgets';
  }
}

/** One line: "If Name contains "uber": category Transport". */
export function describeRule(rule: Pick<Rule, 'match' | 'conditions' | 'actions'>, names: Names) {
  const joiner = rule.match === 'all' ? ' and ' : ' or ';
  const when = rule.conditions.map((c) => describeCondition(c, names)).join(joiner);
  const then = rule.actions.map((a) => describeAction(a, names)).join(', ');
  return `If ${when}: ${then}`;
}

/** "Rules changed 3 transactions." */
export function changedText(n: number): string {
  if (n === 0) return 'No transaction needed a change.';
  return `Rules changed ${n} ${n === 1 ? 'transaction' : 'transactions'}.`;
}
