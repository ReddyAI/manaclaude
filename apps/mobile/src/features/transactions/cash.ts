import {
  currencyInfo,
  formatMoney,
  minorDigits,
  parseMoneyInput,
  type Account,
  type Category,
  type CurrencyCode,
  type DisplayCurrencyMode,
  type FinanceDataset,
  type Transaction,
} from '@manaclaude/shared';
import { compareNewestFirst } from './display';

/**
 * Cash quick-add (session A): a number pad first, then the category. The
 * entry goes to the default cash account in the display currency.
 */

/** The currency a quick-add starts in: the header chip's currency. Both and Native use the main one. */
export function quickAddCurrency(
  mode: DisplayCurrencyMode,
  primaryCurrency: CurrencyCode,
): CurrencyCode {
  return mode === 'USD' || mode === 'INR' ? mode : primaryCurrency;
}

/**
 * The cash account for a currency: the one marked as the default, else any
 * visible cash account in that currency. null when there is none.
 */
export function pickCashAccount(
  accounts: readonly Account[],
  currency: CurrencyCode,
): Account | null {
  const cash = accounts.filter((a) => a.type === 'cash' && a.currency === currency && !a.hidden);
  return cash.find((a) => a.isDefaultCash) ?? cash[0] ?? null;
}

// ---------------------------------------------------------------------------
// Number pad
// ---------------------------------------------------------------------------

export type PadKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '.' | 'back';

export const PAD_KEYS: readonly (readonly PadKey[])[] = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['.', '0', 'back'],
];

const MAX_WHOLE_DIGITS = 9;

/** Next typed value after a key. The value is a plain string like "12.5". */
export function padReduce(value: string, key: PadKey, currency: CurrencyCode): string {
  const digits = minorDigits(currency);
  if (key === 'back') return value.slice(0, -1);
  if (key === '.') {
    if (digits === 0 || value.includes('.')) return value;
    return value === '' ? '0.' : `${value}.`;
  }
  const [whole = '', frac] = value.split('.');
  if (frac !== undefined) return frac.length >= digits ? value : `${value}${key}`;
  if (whole === '0') return key === '0' ? value : key;
  return whole.length >= MAX_WHOLE_DIGITS ? value : `${whole}${key}`;
}

/** The typed value as minor units (0 when empty). */
export function padAmount(value: string, currency: CurrencyCode): number {
  if (value === '' || value === '.') return 0;
  return parseMoneyInput(value, currency) ?? 0;
}

/** What the pad shows: the symbol, grouped digits and exactly what was typed after the point. */
export function padDisplay(value: string, currency: CurrencyCode): string {
  const [whole = '', frac] = value.split('.');
  const wholeMinor = Number(whole || '0') * 10 ** minorDigits(currency);
  const grouped = formatMoney(wholeMinor, currency, { cents: 'never' });
  const symbol = currencyInfo(currency).symbol;
  const body = grouped.startsWith(symbol) ? grouped : `${symbol}${grouped}`;
  return frac === undefined ? body : `${body}.${frac}`;
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export type CashDirection = 'expense' | 'income';

/** Categories for the second step: the ones used most recently first. */
export function quickAddCategories(
  data: FinanceDataset,
  direction: CashDirection,
  today: string,
): Category[] {
  const since = new Date(`${today}T00:00:00Z`);
  since.setUTCDate(since.getUTCDate() - 90);
  const sinceDate = since.toISOString().slice(0, 10);
  const counts = new Map<string, number>();
  for (const t of data.transactions) {
    if (t.categoryId && t.date >= sinceDate)
      counts.set(t.categoryId, (counts.get(t.categoryId) ?? 0) + 1);
  }
  return data.categories
    .filter((c) => c.kind === direction && !c.archived)
    .sort(
      (a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0) || a.name.localeCompare(b.name),
    );
}

export interface CashEntry {
  accountId: string;
  /** Positive minor units; `direction` decides the sign. */
  amount: number;
  direction: CashDirection;
  categoryId: string;
  date: string;
  id: string;
  now: string;
  note?: string;
}

/** Add a cash transaction and move the cash account's balance with it. */
export function applyAddCash(data: FinanceDataset, entry: CashEntry): FinanceDataset {
  const account = data.accounts.find((a) => a.id === entry.accountId);
  const category = data.categories.find((c) => c.id === entry.categoryId);
  if (!account || account.type !== 'cash' || entry.amount <= 0) return data;
  const signed = entry.direction === 'expense' ? -entry.amount : entry.amount;
  const txn: Transaction = {
    id: entry.id,
    accountId: account.id,
    date: entry.date,
    amount: signed,
    currency: account.currency,
    originalAmount: signed,
    originalCurrency: account.currency,
    name: entry.note?.trim() || category?.name || 'Cash',
    rawName: 'Cash',
    merchantId: null,
    categoryId: entry.categoryId,
    categorySource: 'user',
    aiCategoryConfidence: null,
    kind: 'regular',
    pending: false,
    notes: null,
    tagIds: [],
    excluded: false,
    transferLinkId: null,
    receiptId: null,
    recurringId: null,
    splitParentId: null,
    isSplitParent: false,
    reviewed: true,
    reviewedAt: entry.now,
    userEditedFields: ['amount', 'categoryId'],
    source: 'manual',
    connectionId: null,
    externalId: null,
    pendingExternalId: null,
    importId: null,
    importFingerprint: null,
    createdAt: entry.now,
    updatedAt: entry.now,
  };
  return {
    ...data,
    accounts: data.accounts.map((a) =>
      a.id === account.id
        ? { ...a, balance: a.balance + signed, balanceAsOf: entry.now, updatedAt: entry.now }
        : a,
    ),
    transactions: [txn, ...data.transactions].sort(compareNewestFirst),
  };
}
