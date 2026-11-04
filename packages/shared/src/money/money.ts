import type { CurrencyCode, MinorUnits, Money } from '../model/common';
import { minorDigits } from './currencies';

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Throws unless `value` is a safe integer. Use at boundaries (imports, API input). */
export function assertMinorUnits(value: number, label = 'amount'): MinorUnits {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} must be an integer number of minor units, got ${value}`);
  }
  return value;
}

export function money(amount: MinorUnits, currency: CurrencyCode): Money {
  return { amount: assertMinorUnits(amount), currency };
}

function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(`currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function addMoney(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return { amount: a.amount + b.amount, currency: a.currency };
}

export function subtractMoney(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return { amount: a.amount - b.amount, currency: a.currency };
}

export function sumMinor(values: readonly MinorUnits[]): MinorUnits {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

/** Round half away from zero to an integer. */
export function roundHalfAwayFromZero(value: number): number {
  const r = Math.round(Math.abs(value));
  return value < 0 ? -r : r;
}

/** Major units (12.34) to minor units (1234). Only for user input and tests; prefer parseMoneyInput for strings. */
export function fromMajor(major: number, currency: CurrencyCode): MinorUnits {
  const factor = 10 ** minorDigits(currency);
  return roundHalfAwayFromZero(Number((major * factor).toPrecision(15)));
}

/** Minor units to a float in major units. Only for charts and ratios, never for sums you store. */
export function toMajor(amount: MinorUnits, currency: CurrencyCode): number {
  return amount / 10 ** minorDigits(currency);
}

/**
 * Parse what a person typed ("1,234.5", "-12", "₹1,00,000") into minor units.
 * Returns null for anything that is not a plain number.
 */
export function parseMoneyInput(input: string, currency: CurrencyCode): MinorUnits | null {
  const cleaned = input.replace(/[\s,]/g, '').replace(/^[^\d.\-+]+/, '');
  if (!/^[-+]?\d*(\.\d*)?$/.test(cleaned) || cleaned === '' || cleaned === '.' || cleaned === '-') {
    return null;
  }
  const negative = cleaned.startsWith('-');
  const unsigned = cleaned.replace(/^[-+]/, '');
  const [whole = '0', frac = ''] = unsigned.split('.');
  const digits = minorDigits(currency);
  if (frac.length > digits) return null;
  const minor = Number(whole || '0') * 10 ** digits + Number((frac + '0'.repeat(digits)).slice(0, digits) || '0');
  if (!Number.isSafeInteger(minor)) return null;
  return negative ? -minor : minor;
}

/**
 * Split `total` into parts proportional to `weights` so the parts always add
 * up to `total` exactly (largest remainder method). Use for splits and
 * pro-rata allocations.
 */
export function allocate(total: MinorUnits, weights: readonly number[]): MinorUnits[] {
  assertMinorUnits(total, 'total');
  if (weights.length === 0) throw new MoneyError('allocate needs at least one weight');
  if (weights.some((w) => w < 0 || !Number.isFinite(w))) {
    throw new MoneyError('weights must be finite and non-negative');
  }
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (weightSum === 0) throw new MoneyError('weights must not all be zero');
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const raw = weights.map((w) => (abs * w) / weightSum);
  const floors = raw.map((r) => Math.floor(r));
  let remainder = abs - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    remainder -= 1;
  }
  return floors.map((f) => f * sign);
}
