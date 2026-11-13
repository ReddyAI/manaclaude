import type { Rule, RuleInput, RuleResponse } from '@manaclaude/shared';
import { useSyncExternalStore } from 'react';
import { createScopedStore } from '../../data/backend/scopedStore';
import { canSaveToBackend, scheduleRefresh } from '../../data/backend/sync';
import { updateFinance } from '../../data/store';
import { changedText, withEnabled } from './rules';
import { createRule, deleteRule, listRules, runAllRules, updateRule } from './rulesApi';

/** The Worker's rules, in memory only, dropped when the backend changes. */
export const rulesStore = createScopedStore(listRules);

function byPriority(a: Rule, b: Rule): number {
  return a.priority - b.priority || a.id.localeCompare(b.id);
}

function put(list: Rule[] | null, rule: Rule): Rule[] {
  return [...(list ?? []).filter((r) => r.id !== rule.id), rule].sort(byPriority);
}

/** Keeps the app's own copy of the rules in step, for this backend's data only. */
function intoDataset(recipe: (rules: Rule[]) => Rule[]): void {
  if (!canSaveToBackend()) return;
  updateFinance((d) => ({ ...d, rules: recipe(d.rules) }));
}

/** Transactions changed on the Worker: load them again so every screen shows it. */
function afterApplied(n: number): void {
  if (n > 0) scheduleRefresh();
}

// -- the line shown on the rules list after a save, a delete or a run -------------------
let notice: string | null = null;
const noticeListeners = new Set<() => void>();
export function setRulesNotice(text: string | null): void {
  notice = text;
  for (const l of noticeListeners) l();
}
export function useRulesNotice(): string | null {
  return useSyncExternalStore(
    (l) => {
      noticeListeners.add(l);
      return () => noticeListeners.delete(l);
    },
    () => notice,
    () => notice,
  );
}

/**
 * Saves a new rule (id null) or the whole of an existing one. The Worker then
 * applies every enabled rule to every stored transaction; the answer says how
 * many changed.
 */
export async function saveRule(id: string | null, input: RuleInput): Promise<RuleResponse> {
  const res = await rulesStore.mutate(
    () => (id ? updateRule(id, input) : createRule(input)),
    (list, r) => put(list, r.rule),
  );
  intoDataset((rules) => put(rules, res.rule));
  afterApplied(res.applied);
  setRulesNotice(`Saved "${res.rule.name}". ${changedText(res.applied)}`);
  return res;
}

/** Turns a rule on or off: PUT with the rule as stored and `enabled` changed. */
export async function setRuleEnabled(rule: Rule, enabled: boolean): Promise<RuleResponse> {
  const res = await rulesStore.mutate(
    () => updateRule(rule.id, withEnabled(rule, enabled)),
    (list, r) => put(list, r.rule),
  );
  intoDataset((rules) => put(rules, res.rule));
  afterApplied(res.applied);
  setRulesNotice(
    `${enabled ? 'Turned on' : 'Turned off'} "${res.rule.name}". ${changedText(res.applied)}${
      enabled ? '' : ' What it changed before stays as it is.'
    }`,
  );
  return res;
}

export async function removeRule(rule: Rule): Promise<void> {
  await rulesStore.mutate(
    () => deleteRule(rule.id),
    (list) => (list ?? []).filter((r) => r.id !== rule.id),
  );
  intoDataset((rules) => rules.filter((r) => r.id !== rule.id));
  setRulesNotice(`Deleted "${rule.name}". What it changed stays as it is.`);
}

/** Applies every enabled rule to every stored transaction. */
export async function applyRulesNow(): Promise<number> {
  const changed = await rulesStore.mutate(
    () => runAllRules(),
    (list) => list,
  );
  afterApplied(changed);
  setRulesNotice(changedText(changed));
  return changed;
}

/** Tests: the line the rules list would show. */
export function getRulesNoticeForTests(): string | null {
  return notice;
}
