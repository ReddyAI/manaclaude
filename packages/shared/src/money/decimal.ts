import type { CurrencyCode, DecimalString, MinorUnits } from '../model/common';
import { minorDigits } from './currencies';

/**
 * Exact decimal arithmetic for quantities and unit prices, using BigInt with
 * 12 fixed decimal places. Enough for crypto (8 places) and fractional shares.
 */
const SCALE = 12;
const SCALE_FACTOR = 10n ** BigInt(SCALE);

export class DecimalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecimalError';
  }
}

/** "12.5" -> 12500000000000n */
export function toScaled(value: DecimalString): bigint {
  const s = value.trim();
  const m = /^([-+])?(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === '' && (m[3] === undefined || m[3] === ''))) {
    throw new DecimalError(`not a decimal: "${value}"`);
  }
  const sign = m[1] === '-' ? -1n : 1n;
  const whole = BigInt(m[2] || '0');
  let frac = m[3] ?? '';
  if (frac.length > SCALE) {
    // Round half away from zero at the 12th place.
    const roundUp = Number(frac[SCALE]) >= 5;
    frac = frac.slice(0, SCALE);
    const base = whole * SCALE_FACTOR + BigInt(frac);
    return sign * (roundUp ? base + 1n : base);
  }
  return sign * (whole * SCALE_FACTOR + BigInt(frac.padEnd(SCALE, '0')));
}

/** 12500000000000n -> "12.5" */
export function fromScaled(value: bigint): DecimalString {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / SCALE_FACTOR;
  const frac = (abs % SCALE_FACTOR).toString().padStart(SCALE, '0').replace(/0+$/, '');
  const body = frac ? `${whole}.${frac}` : whole.toString();
  return negative && abs !== 0n ? `-${body}` : body;
}

function divRound(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new DecimalError('division by zero');
  const negative = n < 0n !== d < 0n;
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  let q = an / ad;
  if ((an % ad) * 2n >= ad) q += 1n;
  return negative ? -q : q;
}

export function addDec(a: DecimalString, b: DecimalString): DecimalString {
  return fromScaled(toScaled(a) + toScaled(b));
}

export function subDec(a: DecimalString, b: DecimalString): DecimalString {
  return fromScaled(toScaled(a) - toScaled(b));
}

export function mulDec(a: DecimalString, b: DecimalString): DecimalString {
  return fromScaled(divRound(toScaled(a) * toScaled(b), SCALE_FACTOR));
}

export function divDec(a: DecimalString, b: DecimalString): DecimalString {
  return fromScaled(divRound(toScaled(a) * SCALE_FACTOR, toScaled(b)));
}

export function cmpDec(a: DecimalString, b: DecimalString): -1 | 0 | 1 {
  const x = toScaled(a);
  const y = toScaled(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function isZeroDec(a: DecimalString): boolean {
  return toScaled(a) === 0n;
}

export function minDec(a: DecimalString, b: DecimalString): DecimalString {
  return cmpDec(a, b) <= 0 ? a : b;
}

/** For charts and display only. */
export function decToNumber(a: DecimalString): number {
  return Number(a);
}

/** quantity x unit price, rounded to minor units of `currency`. */
export function valueInMinor(
  quantity: DecimalString,
  price: DecimalString,
  currency: CurrencyCode,
): MinorUnits {
  const minorFactor = 10n ** BigInt(minorDigits(currency));
  const product = toScaled(quantity) * toScaled(price) * minorFactor;
  const result = divRound(product, SCALE_FACTOR * SCALE_FACTOR);
  return Number(result);
}

/**
 * The share of `total` that `part / whole` represents, rounded to an integer.
 * Used to pro-rate cost basis and proceeds when a sell consumes part of a lot.
 */
export function proRateMinor(
  total: MinorUnits,
  part: DecimalString,
  whole: DecimalString,
): MinorUnits {
  const w = toScaled(whole);
  if (w === 0n) throw new DecimalError('whole must not be zero');
  return Number(divRound(BigInt(total) * toScaled(part), w));
}
