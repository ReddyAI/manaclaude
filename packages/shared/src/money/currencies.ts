import type { CurrencyCode } from '../model/common';

export interface CurrencyInfo {
  code: CurrencyCode;
  /** Digits after the decimal point (2 for USD and INR, 0 for JPY). */
  minorDigits: number;
  symbol: string;
  name: string;
  /** Indian grouping (1,23,45,678) for INR; western (12,345,678) for the rest. */
  grouping: 'western' | 'indian';
}

const LIST: CurrencyInfo[] = [
  { code: 'USD', minorDigits: 2, symbol: '$', name: 'US dollar', grouping: 'western' },
  { code: 'INR', minorDigits: 2, symbol: '₹', name: 'Indian rupee', grouping: 'indian' },
  { code: 'EUR', minorDigits: 2, symbol: '€', name: 'Euro', grouping: 'western' },
  { code: 'GBP', minorDigits: 2, symbol: '£', name: 'British pound', grouping: 'western' },
  { code: 'CAD', minorDigits: 2, symbol: 'CA$', name: 'Canadian dollar', grouping: 'western' },
  { code: 'AUD', minorDigits: 2, symbol: 'A$', name: 'Australian dollar', grouping: 'western' },
  { code: 'NZD', minorDigits: 2, symbol: 'NZ$', name: 'New Zealand dollar', grouping: 'western' },
  { code: 'SGD', minorDigits: 2, symbol: 'S$', name: 'Singapore dollar', grouping: 'western' },
  { code: 'AED', minorDigits: 2, symbol: 'AED ', name: 'UAE dirham', grouping: 'western' },
  { code: 'CHF', minorDigits: 2, symbol: 'CHF ', name: 'Swiss franc', grouping: 'western' },
  { code: 'CZK', minorDigits: 2, symbol: 'Kč ', name: 'Czech koruna', grouping: 'western' },
  { code: 'UAH', minorDigits: 2, symbol: '₴', name: 'Ukrainian hryvnia', grouping: 'western' },
  { code: 'JPY', minorDigits: 0, symbol: '¥', name: 'Japanese yen', grouping: 'western' },
];

const BY_CODE = new Map(LIST.map((c) => [c.code, c]));

/** Info for a currency code. Unknown codes get 2 decimals and the code as symbol. */
export function currencyInfo(code: CurrencyCode): CurrencyInfo {
  const known = BY_CODE.get(code.toUpperCase());
  if (known) return known;
  return { code, minorDigits: 2, symbol: `${code} `, name: code, grouping: 'western' };
}

export function minorDigits(code: CurrencyCode): number {
  return currencyInfo(code).minorDigits;
}

export const KNOWN_CURRENCIES: readonly CurrencyInfo[] = LIST;
