import {
  addDays,
  addMonthsToMonth,
  formatMonth,
  formatShortDate,
  type Account,
  type HistoryAccountConfig,
  type HistoryPolicy,
  type LocalDate,
  type SourcePeriod,
  type Transaction,
  type YearMonth,
} from '@manaclaude/shared';

/**
 * History sources on the phone: which accounts a policy governs, how many
 * transactions each month has from Monefy and from the bank, and the policy
 * being edited. The Worker decides; this only prepares what is sent and
 * says it in plain words.
 */

/** Connected checking, savings, card, loan and mortgage accounts, as the Worker's rule. */
const BANK_TYPES = new Set(['checking', 'savings', 'credit_card', 'loan', 'mortgage']);

export function isGoverned(a: Pick<Account, 'type' | 'connectionId'>): boolean {
  return a.connectionId !== null && BANK_TYPES.has(a.type);
}

/** A row from a Monefy file (the Worker gives them a "monefy:" id). */
export function isMonefy(t: Pick<Transaction, 'source' | 'externalId'>): boolean {
  return t.source === 'import' && !!t.externalId?.startsWith('monefy:');
}

export interface MonthCount {
  month: YearMonth;
  monefy: number;
  bank: number;
  /** Cash entries, statement files and anything else. */
  other: number;
}

/**
 * Transactions per month by where they came from, newest month first. One
 * account, or every account with `null`. Split parts are counted once (as
 * their whole).
 */
export function monthCounts(
  transactions: readonly Transaction[],
  accountId: string | null,
): MonthCount[] {
  const by = new Map<YearMonth, MonthCount>();
  for (const t of transactions) {
    if (accountId !== null && t.accountId !== accountId) continue;
    if (t.splitParentId) continue;
    const month = t.date.slice(0, 7) as YearMonth;
    const row = by.get(month) ?? { month, monefy: 0, bank: 0, other: 0 };
    if (isMonefy(t)) row.monefy += 1;
    else if (t.source === 'connector') row.bank += 1;
    else row.other += 1;
    by.set(month, row);
  }
  return [...by.values()].sort((a, b) => b.month.localeCompare(a.month));
}

/**
 * The same list with every month between the newest and the oldest, so a
 * month with nothing at all shows as a gap instead of being skipped.
 */
export function withEmptyMonths(counts: readonly MonthCount[]): MonthCount[] {
  const newest = counts[0]?.month;
  const oldest = counts[counts.length - 1]?.month;
  if (!newest || !oldest) return [];
  const by = new Map(counts.map((c) => [c.month, c]));
  const out: MonthCount[] = [];
  for (let m = newest; m >= oldest; m = addMonthsToMonth(m, -1)) {
    out.push(by.get(m) ?? { month: m, monefy: 0, bank: 0, other: 0 });
  }
  return out;
}

/** "Mar 2025" */
export function monthLabel(m: YearMonth): string {
  return formatMonth(m).replace(/^(\w{3})\w*/, '$1');
}

/** The Worker takes at most this many months per account. */
export const MAX_MONTHS = 240;

/**
 * Months that can be given to the bank, newest first: complete calendar
 * months before the cutoff's month, back to `earliest` (and at least two
 * years back, so an account with no Monefy rows yet still has a choice).
 */
export function selectableMonths(cutoff: LocalDate, earliest: YearMonth | null): YearMonth[] {
  const last = addMonthsToMonth(cutoff.slice(0, 7) as YearMonth, -1);
  const twoYears = addMonthsToMonth(last, -23);
  const first = earliest && earliest < twoYears ? earliest : twoYears;
  const out: YearMonth[] = [];
  for (let m = last; m >= first && out.length < MAX_MONTHS; m = addMonthsToMonth(m, -1)) {
    out.push(m);
  }
  return out;
}

export type AccountMode = 'default' | 'custom' | 'monefy_only';

export interface AccountDraft {
  mode: AccountMode;
  /** Own cutoff, for 'custom'. */
  cutoff: string;
  months: YearMonth[];
}

export interface PolicyDraft {
  defaultCutoff: string;
  accounts: Record<string, AccountDraft>;
}

export const EMPTY_ACCOUNT: AccountDraft = { mode: 'default', cutoff: '', months: [] };

export function draftFrom(policy: HistoryPolicy): PolicyDraft {
  const accounts: Record<string, AccountDraft> = {};
  for (const c of policy.accounts) {
    accounts[c.accountId] =
      c.mode === 'monefy_only'
        ? { mode: 'monefy_only', cutoff: '', months: [] }
        : {
            mode: c.mode,
            cutoff: c.mode === 'custom' ? c.cutoff : '',
            months: [...c.replacementMonths] as YearMonth[],
          };
  }
  return { defaultCutoff: policy.defaultCutoff ?? '', accounts };
}

/**
 * The policy to send. An account left on the default with no months gets no
 * entry: it inherits the default, as the Worker does for accounts it has not
 * been told about.
 */
export function policyFrom(draft: PolicyDraft, governedIds: readonly string[]): HistoryPolicy {
  const accounts: HistoryAccountConfig[] = [];
  for (const id of [...governedIds].sort()) {
    const a = draft.accounts[id];
    if (!a) continue;
    if (a.mode === 'monefy_only') accounts.push({ accountId: id, mode: 'monefy_only' });
    else if (a.mode === 'custom')
      accounts.push({
        accountId: id,
        mode: 'custom',
        cutoff: a.cutoff.trim(),
        replacementMonths: [...a.months].sort(),
      });
    else if (a.months.length > 0)
      accounts.push({ accountId: id, mode: 'default', replacementMonths: [...a.months].sort() });
  }
  return { defaultCutoff: draft.defaultCutoff.trim() || null, accounts };
}

export function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** What has to be fixed before the Worker is asked; empty when ready to check. */
export function draftProblems(
  draft: PolicyDraft,
  governed: readonly Pick<Account, 'id' | 'name'>[],
): string[] {
  const problems: string[] = [];
  if (!isRealDate(draft.defaultCutoff.trim()))
    problems.push('Enter the cutoff as a date, for example 2025-06-01.');
  for (const account of governed) {
    const a = draft.accounts[account.id];
    if (!a || a.mode === 'monefy_only') continue;
    const cutoff = a.mode === 'custom' ? a.cutoff.trim() : draft.defaultCutoff.trim();
    if (a.mode === 'custom' && !isRealDate(cutoff)) {
      problems.push(`Enter "${account.name}"'s own cutoff as a date.`);
      continue;
    }
    if (!isRealDate(cutoff)) continue;
    const late = a.months.filter((m) => m >= cutoff.slice(0, 7));
    if (late.length > 0)
      problems.push(
        `"${account.name}": ${late.map((m) => formatMonth(m)).join(', ')} ${late.length === 1 ? 'is' : 'are'} not before the cutoff's month. Only whole months before it can go to the bank.`,
      );
    if (a.months.length > MAX_MONTHS)
      problems.push(`"${account.name}": at most ${MAX_MONTHS} months.`);
  }
  return problems;
}

/** "Jun 17, 2025": always with the year. */
export function withYear(date: LocalDate): string {
  return formatShortDate(date, '0000-01-01');
}

/** One period of an account's timeline in words. */
export function periodText(p: SourcePeriod): string {
  const who = p.source === 'monefy' ? 'Monefy' : p.source === 'bank' ? 'Bank' : 'Its own';
  if (p.source === 'independent') return 'Not governed: every source is kept as it comes.';
  if (p.from === null && p.to === null) return `${who}, every date`;
  if (p.from === null) return `${who} until ${withYear(p.to!)}`;
  if (p.to === null) return `${who} from ${withYear(p.from)}`;
  if (
    p.from.slice(0, 7) === p.to.slice(0, 7) &&
    p.from.endsWith('-01') &&
    addDays(p.to, 1).endsWith('-01')
  )
    return `${who}, all of ${formatMonth(p.from.slice(0, 7) as YearMonth)}`;
  return `${who}, ${withYear(p.from)} to ${withYear(p.to)}`;
}

export const REPLACES_ALL =
  "A month you give to the bank replaces all of that account's Monefy entries in that month, even scattered ones. Months with few entries are never picked for you.";

export const NOT_COMPLETE =
  "A bank connection may not reach back to an old month, and the app cannot tell whether a month came through complete. For older months, import the bank's statement file for that month.";
