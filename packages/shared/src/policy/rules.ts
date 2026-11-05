import type { Rule, RuleAction, RuleCondition } from '../model/rule';
import type { Transaction, UserEditableField } from '../model/transaction';

function textMatches(cond: Extract<RuleCondition, { field: 'name' | 'rawName' }>, value: string) {
  const a = cond.caseSensitive ? value : value.toLowerCase();
  const b = cond.caseSensitive ? cond.value : cond.value.toLowerCase();
  switch (cond.op) {
    case 'contains':
      return a.includes(b);
    case 'equals':
      return a === b;
    case 'starts_with':
      return a.startsWith(b);
    case 'regex':
      try {
        return new RegExp(cond.value, cond.caseSensitive ? '' : 'i').test(value);
      } catch {
        return false;
      }
  }
}

export function conditionMatches(cond: RuleCondition, txn: Transaction): boolean {
  switch (cond.field) {
    case 'name':
    case 'rawName':
      return textMatches(cond, txn[cond.field]);
    case 'amount': {
      // Amount conditions compare the size of the amount, so "over $50" works for purchases.
      const v = Math.abs(txn.amount);
      if (cond.op === 'between') return v >= cond.value[0] && v <= cond.value[1];
      if (cond.op === 'equals') return v === cond.value;
      if (cond.op === 'gt') return v > cond.value;
      return v < cond.value;
    }
    case 'accountId':
    case 'categoryId':
    case 'currency': {
      const v = txn[cond.field];
      if (v === null) return false;
      return cond.op === 'in'
        ? (Array.isArray(cond.value) ? cond.value : [cond.value]).includes(v)
        : v === cond.value;
    }
  }
}

export function ruleMatches(rule: Rule, txn: Transaction): boolean {
  if (!rule.enabled || rule.conditions.length === 0) return false;
  return rule.match === 'all'
    ? rule.conditions.every((c) => conditionMatches(c, txn))
    : rule.conditions.some((c) => conditionMatches(c, txn));
}

const ACTION_FIELD: Record<RuleAction['type'], UserEditableField | null> = {
  set_category: 'categoryId',
  set_name: 'name',
  set_kind: 'kind',
  add_tag: 'tagIds',
  mark_reviewed: null,
  exclude: 'excluded',
};

export interface RuleApplication {
  transaction: Transaction;
  /** Rule ids that changed something. */
  appliedRuleIds: string[];
  /** Fields the rules wanted to change but the user had edited. */
  protectedFields: UserEditableField[];
}

/**
 * Runs the rules on one transaction, lowest priority number first. For each
 * field the first matching rule wins. Fields in userEditedFields are never
 * changed (research/sure/rea.md check 4).
 */
export function applyRules(txn: Transaction, rules: readonly Rule[]): RuleApplication {
  const sorted = [...rules].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const out: Transaction = { ...txn, tagIds: [...txn.tagIds] };
  const setByRule = new Set<string>();
  const applied = new Set<string>();
  const protectedFields = new Set<UserEditableField>();
  for (const rule of sorted) {
    if (!ruleMatches(rule, out)) continue;
    for (const action of rule.actions) {
      const field = ACTION_FIELD[action.type];
      if (field && txn.userEditedFields.includes(field)) {
        protectedFields.add(field);
        continue;
      }
      const slot = action.type === 'add_tag' ? `tag:${action.tagId}` : action.type;
      if (setByRule.has(slot)) continue;
      setByRule.add(slot);
      switch (action.type) {
        case 'set_category':
          if (out.categoryId !== action.categoryId || out.categorySource !== 'rule') {
            out.categoryId = action.categoryId;
            out.categorySource = 'rule';
            out.aiCategoryConfidence = null;
            applied.add(rule.id);
          }
          break;
        case 'set_name':
          if (out.name !== action.name) {
            out.name = action.name;
            applied.add(rule.id);
          }
          break;
        case 'set_kind':
          if (out.kind !== action.kind) {
            out.kind = action.kind;
            applied.add(rule.id);
          }
          break;
        case 'add_tag':
          if (!out.tagIds.includes(action.tagId)) {
            out.tagIds.push(action.tagId);
            applied.add(rule.id);
          }
          break;
        case 'mark_reviewed':
          if (!out.reviewed) {
            out.reviewed = true;
            applied.add(rule.id);
          }
          break;
        case 'exclude':
          if (!out.excluded) {
            out.excluded = true;
            applied.add(rule.id);
          }
          break;
      }
    }
  }
  return { transaction: out, appliedRuleIds: [...applied], protectedFields: [...protectedFields] };
}

/**
 * Copies `changes` onto a transaction except fields the user edited. Used by
 * sync, imports and AI jobs so none of them can overwrite a user edit.
 */
export function mergeRespectingUserEdits(
  txn: Transaction,
  changes: Partial<Transaction>,
): { transaction: Transaction; skipped: UserEditableField[] } {
  const out: Transaction = { ...txn };
  const skipped: UserEditableField[] = [];
  for (const [key, value] of Object.entries(changes) as [keyof Transaction, unknown][]) {
    if ((txn.userEditedFields as string[]).includes(key)) {
      skipped.push(key as UserEditableField);
      continue;
    }
    // Category bookkeeping follows the category itself.
    if (
      (key === 'categorySource' || key === 'aiCategoryConfidence') &&
      txn.userEditedFields.includes('categoryId')
    ) {
      continue;
    }
    (out as unknown as Record<string, unknown>)[key] = value;
  }
  return { transaction: out, skipped };
}
