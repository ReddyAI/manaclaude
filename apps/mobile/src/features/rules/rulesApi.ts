import type {
  Rule,
  RuleInput,
  RuleResponse,
  RuleRunResponse,
  RulesResponse,
} from '@manaclaude/shared';
import { api } from '../../data/backend/client';

/** Saving a rule applies every enabled rule to every stored transaction, which can take a while. */
const SAVE_TIMEOUT_MS = 60_000;

/** GET /v1/rules, by priority. */
export async function listRules(): Promise<Rule[]> {
  return (await api<RulesResponse>('GET', '/v1/rules')).rules;
}

/**
 * POST /v1/rules. The Worker saves the rule, then applies every enabled rule
 * to every stored transaction and says how many changed (`applied`).
 */
export function createRule(input: RuleInput): Promise<RuleResponse> {
  return api<RuleResponse>('POST', '/v1/rules', input, { timeoutMs: SAVE_TIMEOUT_MS });
}

/** PUT /v1/rules/:id: the whole rule again. Applies the rules the same way as POST. */
export function updateRule(id: string, input: RuleInput): Promise<RuleResponse> {
  return api<RuleResponse>('PUT', `/v1/rules/${encodeURIComponent(id)}`, input, {
    timeoutMs: SAVE_TIMEOUT_MS,
  });
}

/** DELETE /v1/rules/:id (204). What the rule already changed stays changed. */
export async function deleteRule(id: string): Promise<void> {
  await api<null>('DELETE', `/v1/rules/${encodeURIComponent(id)}`);
}

/** POST /v1/rules/run: every enabled rule on every stored transaction. */
export async function runAllRules(): Promise<number> {
  return (await api<RuleRunResponse>('POST', '/v1/rules/run', {}, { timeoutMs: SAVE_TIMEOUT_MS }))
    .changed;
}
