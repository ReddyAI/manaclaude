import type { CurrencyCode, MinorUnits } from '../model/common';
import { currencyInfo } from './currencies';

/** Typographic minus. Same width as digits in Inter's tabular figures. */
export const MINUS = '−';

export interface FormatMoneyOptions {
  /**
   * 'always' shows minor digits, 'never' rounds to whole units,
   * 'auto' hides them when the amount is 10,000 or more in major units.
   */
  cents?: 'always' | 'never' | 'auto';
  /**
   * 'negative' prefixes a minus only for negative amounts,
   * 'always' adds + for positive amounts (income rows),
   * 'never' drops the sign (when color or layout already shows direction).
   */
  sign?: 'negative' | 'always' | 'never';
  /** Short form: $12.3K, $1.2M; INR uses lakh and crore (₹1.2L, ₹3.4Cr). */
  compact?: boolean;
  /** Append the ISO code instead of using the symbol ("1,234.00 USD"). */
  code?: boolean;
}

function groupDigits(intDigits: string, grouping: 'western' | 'indian'): string {
  if (intDigits.length <= 3) return intDigits;
  if (grouping === 'western') {
    return intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  const last3 = intDigits.slice(-3);
  const rest = intDigits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${rest},${last3}`;
}

function trimFixed(value: number, decimals: number): string {
  return value.toFixed(decimals).replace(/\.?0+$/, '');
}

function compactBody(absMajor: number, grouping: 'western' | 'indian'): string | null {
  if (grouping === 'indian') {
    if (absMajor >= 1e7) return `${trimFixed(absMajor / 1e7, absMajor >= 1e9 ? 0 : 2)}Cr`;
    if (absMajor >= 1e5) return `${trimFixed(absMajor / 1e5, 2)}L`;
    if (absMajor >= 1e3) return `${trimFixed(absMajor / 1e3, 1)}K`;
    return null;
  }
  if (absMajor >= 1e9) return `${trimFixed(absMajor / 1e9, 2)}B`;
  if (absMajor >= 1e6) return `${trimFixed(absMajor / 1e6, 2)}M`;
  if (absMajor >= 1e3) return `${trimFixed(absMajor / 1e3, absMajor >= 1e5 ? 0 : 1)}K`;
  return null;
}

/**
 * Format integer minor units for display. Pure and locale-independent so
 * Android, web and tests print the same thing.
 *
 * formatMoney(123456, 'USD') -> "$1,234.56"
 * formatMoney(-12345678, 'INR') -> "−₹1,23,456.78"
 * formatMoney(1234567800, 'INR', { compact: true }) -> "₹1.23Cr"
 */
export function formatMoney(
  amount: MinorUnits,
  currency: CurrencyCode,
  options: FormatMoneyOptions = {},
): string {
  const info = currencyInfo(currency);
  const { cents = 'always', sign = 'negative', compact = false, code = false } = options;
  const negative = amount < 0;
  const absMinor = Math.abs(amount);
  const factor = 10 ** info.minorDigits;
  const absMajor = absMinor / factor;

  let body: string | null = compact ? compactBody(absMajor, info.grouping) : null;
  if (body === null) {
    const showMinor =
      info.minorDigits > 0 &&
      (cents === 'always' || (cents === 'auto' && absMajor < 10_000)) &&
      !(compact && absMinor % factor === 0);
    if (showMinor) {
      const intPart = Math.floor(absMinor / factor).toString();
      const fracPart = (absMinor % factor).toString().padStart(info.minorDigits, '0');
      body = `${groupDigits(intPart, info.grouping)}.${fracPart}`;
    } else {
      const rounded = Math.round(absMajor).toString();
      body = groupDigits(rounded, info.grouping);
    }
  }

  const prefix = negative && sign !== 'never' ? MINUS : !negative && amount !== 0 && sign === 'always' ? '+' : '';
  return code ? `${prefix}${body} ${info.code}` : `${prefix}${info.symbol}${body}`;
}

/** "USD 1 = INR 88.42" style label for a rate. */
export function formatRate(rate: number, base: CurrencyCode, quote: CurrencyCode): string {
  const digits = rate >= 100 ? 2 : rate >= 1 ? 4 : 6;
  return `1 ${base} = ${rate.toFixed(digits)} ${quote}`;
}
