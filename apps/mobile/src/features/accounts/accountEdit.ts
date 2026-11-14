import {
  classifyAccountType,
  minorDigits,
  parseMoneyInput,
  type Account,
  type AccountPatchRequest,
  type AccountType,
  type Connection,
  type FinanceDataset,
} from '@manaclaude/shared';
import { manualBalanceOf } from '../../data/manualBalance';
import { isRealDate } from '../transactions/edit';

/**
 * The edit form for an account with no connection and how it becomes a PATCH
 * /v1/accounts/:id body (the contract in docs/handoff/codex-log.md, "Item 2").
 *
 * Only what changed is sent, with the version token the form was loaded with.
 * Currency, subtype, opening balance, provider fields, the default-cash mark
 * and the hidden flag cannot change through this route; the form does not
 * offer them.
 */

export const ACCOUNT_NAME_MAX = 100;

/** Plain names for every kind, in the order the form offers them. */
export const KIND_LABEL: Record<AccountType, string> = {
  checking: 'Checking',
  savings: 'Savings',
  credit_card: 'Credit card',
  cash: 'Cash',
  brokerage: 'Brokerage',
  retirement: 'Retirement',
  crypto: 'Crypto',
  loan: 'Loan',
  mortgage: 'Mortgage',
  property: 'Property',
  vehicle: 'Vehicle',
  other_asset: 'Other asset',
  other_liability: 'Other debt',
};

/** Kinds a non-cash account can become. Cash never changes kind, and nothing becomes cash. */
export const NON_CASH_KINDS: readonly AccountType[] = (
  Object.keys(KIND_LABEL) as AccountType[]
).filter((t) => t !== 'cash');

/** True for an account a provider keeps (a connection or a provider's own id). */
export function isProviderAccount(account: Pick<Account, 'connectionId' | 'externalId'>): boolean {
  return account.connectionId !== null || account.externalId !== null;
}

/** Why a provider account is read-only, in plain words. */
export function readOnlyReason(account: Account, connections: readonly Connection[]): string {
  const connection = account.connectionId
    ? connections.find((c) => c.id === account.connectionId)
    : undefined;
  const from = connection?.institutionName ?? account.institutionName;
  const source = from ? `your ${from} connection` : 'a bank or broker connection';
  return `This account comes from ${source}, which keeps its name, kind and balance up to date, so they can't be changed here. It can't be removed here either.`;
}

/** Why the kind is locked, or null when it may change. */
export function kindLock(account: Account, data: Pick<FinanceDataset, 'holdings' | 'activities'>) {
  if (account.type === 'cash')
    return 'A cash account stays a cash account, and other accounts cannot become cash.';
  const investments =
    data.holdings.some((h) => h.accountId === account.id) ||
    data.activities.some((a) => a.accountId === account.id);
  if (investments)
    return 'This account has investment records (holdings or activity), so its kind cannot change.';
  return null;
}

export interface AccountDraft {
  name: string;
  type: AccountType;
  balance: 'known' | 'unknown';
  /** The balance as typed. A minus sign is allowed except for cash. */
  amount: string;
  /** "YYYY-MM-DD": the day the balance was true. */
  asOfDate: string;
  includeInNetWorth: boolean;
}

/** Minor units as text with the currency's decimals, keeping the sign: -1234 USD is "-12.34". */
export function signedAmountText(minor: number, currency: string): string {
  const digits = minorDigits(currency);
  const size = Math.abs(minor);
  const sign = minor < 0 ? '-' : '';
  if (digits === 0) return `${sign}${size}`;
  const whole = Math.floor(size / 10 ** digits);
  const frac = String(size % 10 ** digits).padStart(digits, '0');
  return `${sign}${whole}.${frac}`;
}

export function balanceKnown(account: Account): boolean {
  return manualBalanceOf(account)?.currentKnown ?? true;
}

/** The form as the Worker's account is now. An unknown balance starts empty, never as 0. */
export function draftFrom(account: Account, today: string): AccountDraft {
  const known = balanceKnown(account);
  return {
    name: account.name,
    type: account.type,
    balance: known ? 'known' : 'unknown',
    amount: known ? signedAmountText(account.balance, account.currency) : '',
    asOfDate: known ? account.balanceAsOf.slice(0, 10) : today,
    includeInNetWorth: known && account.includeInNetWorth,
  };
}

/**
 * Switching between a known and an unknown balance. Unknown is always out of
 * net worth. Going from unknown to known turns the switch on, as making an
 * account with a balance does; the form shows it so it can be turned off.
 */
export function chooseBalance(
  draft: AccountDraft,
  choice: AccountDraft['balance'],
  account: Account,
): AccountDraft {
  if (choice === draft.balance) return draft;
  if (choice === 'unknown') return { ...draft, balance: 'unknown', includeInNetWorth: false };
  return {
    ...draft,
    balance: 'known',
    includeInNetWorth: balanceKnown(account) ? account.includeInNetWorth : true,
  };
}

/** Noon UTC on the day given, so the date reads the same in India and the US (as on the import form). */
export const asOfFor = (date: string) => `${date}T12:00:00.000Z`;

export type AccountEditBody = Omit<AccountPatchRequest, 'expectedVersion'>;

export interface AccountEditCheck {
  /** The PATCH body without the version, or null when there is a problem or nothing changed. */
  body: AccountEditBody | null;
  problems: Partial<Record<'name' | 'type' | 'amount' | 'date', string>>;
  /** The balance (known or unknown, amount or date) differs from the Worker's. */
  balanceChanged: boolean;
  unchanged: boolean;
}

export function checkAccountEdit(
  draft: AccountDraft,
  account: Account,
  ctx: { today: string; kindLock: string | null },
): AccountEditCheck {
  const problems: AccountEditCheck['problems'] = {};
  const body: AccountEditBody = {};

  const name = draft.name.trim();
  if (!name) problems.name = 'Type a name.';
  else if (name.length > ACCOUNT_NAME_MAX)
    problems.name = `Use at most ${ACCOUNT_NAME_MAX} characters (${name.length} now).`;
  else if (name !== account.name) body.name = name;

  if (draft.type !== account.type) {
    if (ctx.kindLock) problems.type = ctx.kindLock;
    else if (draft.type === 'cash') problems.type = 'An account cannot become a cash account.';
    else body.type = draft.type;
  }

  const wasKnown = balanceKnown(account);
  let balanceChanged = false;
  if (draft.balance === 'unknown') {
    if (wasKnown) {
      balanceChanged = true;
      body.currentBalance = null;
    }
  } else {
    const amount = draft.amount.trim() ? parseMoneyInput(draft.amount, account.currency) : null;
    if (amount === null)
      problems.amount = `Type the balance as a number, with at most ${minorDigits(account.currency)} decimals.`;
    else if (!Number.isSafeInteger(amount)) problems.amount = 'That number is too large.';
    else if (account.type === 'cash' && amount < 0)
      problems.amount = 'Cash on hand cannot be below zero.';
    const opening = manualBalanceOf(account)?.openingBalance ?? null;
    if (!isRealDate(draft.asOfDate)) problems.date = 'Use a real date written as YYYY-MM-DD.';
    else if (draft.asOfDate > ctx.today) problems.date = 'The date cannot be after today.';
    else if (opening && opening.date > draft.asOfDate)
      problems.date = `The date cannot be before the opening balance date (${opening.date}).`;
    if (amount !== null && !problems.amount && !problems.date) {
      balanceChanged =
        !wasKnown ||
        amount !== account.balance ||
        draft.asOfDate !== account.balanceAsOf.slice(0, 10);
      if (balanceChanged) body.currentBalance = { amount, asOf: asOfFor(draft.asOfDate) };
    }
  }

  const include = draft.balance === 'known' && draft.includeInNetWorth;
  // Sent every time the balance changes, so the choice is always the one shown.
  if (balanceChanged || include !== account.includeInNetWorth) body.includeInNetWorth = include;

  if (Object.keys(problems).length > 0)
    return { body: null, problems, balanceChanged, unchanged: false };
  const unchanged = Object.keys(body).length === 0;
  return { body: unchanged ? null : body, problems, balanceChanged, unchanged };
}

/**
 * After a lost answer or a 409, the account is read again. True when the
 * Worker already has everything this edit asked for, so it can be shown as
 * saved instead of asking to save again.
 */
export function matchesEdit(account: Account, body: AccountEditBody): boolean {
  if (body.name !== undefined && account.name !== body.name) return false;
  if (body.type !== undefined && account.type !== body.type) return false;
  if (body.currentBalance === null && balanceKnown(account)) return false;
  if (body.currentBalance) {
    if (!balanceKnown(account)) return false;
    if (account.balance !== body.currentBalance.amount) return false;
    if (Date.parse(account.balanceAsOf) !== Date.parse(body.currentBalance.asOf)) return false;
  }
  if (body.includeInNetWorth !== undefined && account.includeInNetWorth !== body.includeInNetWorth)
    return false;
  return true;
}

/** What the balance field is called for this kind of account. */
export function balanceLabel(type: AccountType): string {
  if (type === 'cash') return 'Cash on hand';
  return classifyAccountType(type) === 'liability' ? 'Amount owed' : 'Balance';
}
