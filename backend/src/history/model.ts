import {
  addDays,
  daysBetween,
  parseDateWithFormat,
  type Account,
  type Transaction,
} from '@manaclaude/shared';
import { z } from 'zod';
import { badRequest } from '../util/errors';

const date = z
  .string()
  .refine(
    (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !!parseDateWithFormat(s, 'YYYY-MM-DD'),
    'Use a real YYYY-MM-DD date.',
  );
const months = z.array(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)).max(240);
export const historyPolicySchema = z
  .object({
    defaultCutoff: date.nullable(),
    accounts: z
      .array(
        z.discriminatedUnion('mode', [
          z
            .object({
              accountId: z.string().min(1),
              mode: z.literal('default'),
              replacementMonths: months,
            })
            .strict(),
          z
            .object({
              accountId: z.string().min(1),
              mode: z.literal('custom'),
              cutoff: date,
              replacementMonths: months,
            })
            .strict(),
          z.object({ accountId: z.string().min(1), mode: z.literal('monefy_only') }).strict(),
        ]),
      )
      .max(200),
  })
  .strict();
export type HistoryPolicy = z.infer<typeof historyPolicySchema>;
export interface PolicyState {
  version: number;
  policy: HistoryPolicy;
  reviewToken: string | null;
}
export const EMPTY_POLICY: HistoryPolicy = { defaultCutoff: null, accounts: [] };
export const BANK_TYPES = new Set(['checking', 'savings', 'credit_card', 'loan', 'mortgage']);
export function isBankAccount(a: Pick<Account, 'type' | 'connectionId'>): boolean {
  return a.connectionId !== null && BANK_TYPES.has(a.type);
}
export function effectivePolicy(policy: HistoryPolicy, account: Account) {
  if (!isBankAccount(account)) return null;
  const config = policy.accounts.find((c) => c.accountId === account.id);
  if (config?.mode === 'monefy_only')
    return { cutoff: null, replacementMonths: [] as string[], origin: 'monefy_only' as const };
  const cutoff = config?.mode === 'custom' ? config.cutoff : policy.defaultCutoff;
  if (!cutoff) return null;
  return {
    cutoff,
    replacementMonths: config?.replacementMonths ?? [],
    origin: config?.mode ?? 'default',
  };
}
export function bankOwns(policy: HistoryPolicy, account: Account, date: string): boolean | null {
  const rule = effectivePolicy(policy, account);
  if (!rule) return null; // Independent/legacy; no source selection was activated.
  return (
    rule.cutoff !== null &&
    (date >= rule.cutoff || rule.replacementMonths.includes(date.slice(0, 7)))
  );
}
export function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return addDays(
    `${m === 12 ? y! + 1 : y!}-${String(m === 12 ? 1 : m! + 1).padStart(2, '0')}-01`,
    -1,
  );
}
export function normalizePolicy(input: HistoryPolicy, accounts: Account[]): HistoryPolicy {
  const policy = historyPolicySchema.parse(input);
  if (!policy.defaultCutoff)
    throw badRequest(
      'Saving a source policy requires a default cutoff. Use a per-account Monefy-only exception when needed.',
      'invalid_body',
    );
  if (new Set(policy.accounts.map((c) => c.accountId)).size !== policy.accounts.length)
    throw badRequest('An account may have only one history configuration.', 'invalid_body');
  for (const config of policy.accounts) {
    const account = accounts.find((a) => a.id === config.accountId);
    if (!account || !isBankAccount(account))
      throw badRequest(
        'Configure an existing connected bank or card account. Cash, unconnected and investment accounts remain independent.',
        'invalid_body',
      );
    if (config.mode === 'monefy_only') continue;
    const cutoff = config.mode === 'custom' ? config.cutoff : policy.defaultCutoff;
    if (!cutoff)
      throw badRequest('Default-mode accounts require a default cutoff.', 'invalid_body');
    if (new Set(config.replacementMonths).size !== config.replacementMonths.length)
      throw badRequest('Replacement months must be unique.', 'invalid_body');
    for (const month of config.replacementMonths) {
      if (
        !parseDateWithFormat(`${month}-01`, 'YYYY-MM-DD') ||
        month >= cutoff.slice(0, 7) ||
        monthEnd(month) >= cutoff
      )
        throw badRequest(
          'Each replacement month must be a complete calendar month strictly before the cutoff.',
          'invalid_body',
        );
    }
    config.replacementMonths.sort();
  }
  policy.accounts.sort((a, b) => a.accountId.localeCompare(b.accountId));
  return policy;
}
export function sourcePeriods(policy: HistoryPolicy, account: Account) {
  const rule = effectivePolicy(policy, account);
  if (!rule) return [{ source: 'independent' as const, from: null, to: null }];
  if (!rule.cutoff) return [{ source: 'monefy' as const, from: null, to: null }];
  const periods: { source: 'monefy' | 'bank'; from: string | null; to: string | null }[] = [];
  let from: string | null = null;
  for (const month of rule.replacementMonths) {
    const start = `${month}-01`,
      end = monthEnd(month);
    if (from !== start) periods.push({ source: 'monefy', from, to: addDays(start, -1) });
    periods.push({ source: 'bank', from: start, to: end });
    from = addDays(end, 1);
  }
  if (from !== rule.cutoff) periods.push({ source: 'monefy', from, to: addDays(rule.cutoff, -1) });
  periods.push({ source: 'bank', from: rule.cutoff, to: null });
  return periods;
}

export const isMonefy = (t: Transaction) =>
  t.source === 'import' && !!t.externalId?.startsWith('monefy:');
export function monefyCandidates(t: Transaction, existing: readonly Transaction[]): Transaction[] {
  return existing.filter(
    (other) =>
      isMonefy(other) &&
      !other.splitParentId &&
      other.accountId === t.accountId &&
      other.amount === t.amount &&
      other.currency === t.currency &&
      Math.abs(daysBetween(other.date, t.date)) <= 3,
  );
}
