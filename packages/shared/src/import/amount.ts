import type { CurrencyCode, MinorUnits } from '../model/common';
import { minorDigits } from '../money/currencies';

export type DecimalSeparator = '.' | ',';

/**
 * Reads an amount string from a statement into minor units without floats:
 * "1,234.56", "-12.50", "(12.50)", "12.50-", "$1,234.00", "Rs. 1,23,456.00",
 * "12.50 DR", "1.234,56" (with decimalSeparator ','). Returns null when the
 * text is not a number.
 */
export function parseAmountText(
  raw: string,
  currency: CurrencyCode,
  decimalSeparator: DecimalSeparator = '.',
): MinorUnits | null {
  let s = raw.trim();
  if (!s) return null;
  let negative = false;
  const crdr = s.match(/\s*\b(CR|DR|Cr|Dr|cr|dr)\.?$/);
  if (crdr) {
    negative = crdr[1]!.toLowerCase() === 'dr';
    s = s.slice(0, crdr.index).trim();
  }
  if (/^\(.*\)$/.test(s)) {
    negative = !negative;
    s = s.slice(1, -1).trim();
  }
  if (s.endsWith('-')) {
    negative = !negative;
    s = s.slice(0, -1).trim();
  }
  // Drop currency symbols and codes.
  s = s.replace(/^(?:[A-Z]{3}|Rs\.?|INR|USD|[$€£₹¥])\s*/i, '').trim();
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1).trim();
  } else if (s.startsWith('+')) {
    s = s.slice(1).trim();
  }
  s = s.replace(/^(?:[$€£₹¥])\s*/, '').replace(/\s*(?:[$€£₹¥])$/, '');
  const group = decimalSeparator === '.' ? /[,'\s]/g : /[.'\s]/g;
  s = s.replace(group, '');
  if (decimalSeparator === ',') s = s.replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s) && !/^\.\d+$/.test(s)) return null;
  const [whole = '0', frac = ''] = s.split('.');
  const digits = minorDigits(currency);
  if (frac.length > digits && /[1-9]/.test(frac.slice(digits))) {
    // More precision than the currency has: round half away from zero.
    const kept = frac.slice(0, digits);
    const roundUp = Number(frac[digits]) >= 5;
    const base = Number((whole || '0') + kept.padEnd(digits, '0'));
    const value = roundUp ? base + 1 : base;
    return negative ? -value : value;
  }
  const value = Number((whole || '0') + frac.slice(0, digits).padEnd(digits, '0'));
  if (!Number.isSafeInteger(value)) return null;
  return negative && value !== 0 ? -value : value;
}

/** Guesses the decimal separator from sample values ("1.234,56" style uses ','). */
export function detectDecimalSeparator(values: readonly string[]): DecimalSeparator {
  let comma = 0;
  let dot = 0;
  for (const v of values) {
    if (/,\d{2}(?!\d)\s*\)?\s*-?$/.test(v.trim()) && !/\.\d{2}(?!\d)/.test(v)) comma += 1;
    if (/\.\d{1,2}(?!\d)/.test(v)) dot += 1;
  }
  return comma > dot ? ',' : '.';
}
