import type { CurrencyCode, DecimalString, MinorUnits } from '@manaclaude/shared';
import { toScaled, fromScaled, valueInMinor, mulDec } from '@manaclaude/shared';

/**
 * Turn a number or string from a provider into an exact decimal string.
 * JSON numbers such as 1e-7 or 0.1 + 0.2 never go through float math here.
 */
export function toDecimalString(value: string | number | null | undefined): DecimalString | null {
  if (value === null || value === undefined) return null;
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    text = /e/i.test(String(value)) ? value.toFixed(20) : String(value);
  } else {
    text = value.trim();
  }
  if (text === '') return null;
  if (/e/i.test(text)) {
    const n = Number(text);
    if (!Number.isFinite(n)) return null;
    text = n.toFixed(20);
  }
  try {
    return fromScaled(toScaled(text));
  } catch {
    return null;
  }
}

/** Like toDecimalString but "0" instead of null. */
export function decimalOrZero(value: string | number | null | undefined): DecimalString {
  return toDecimalString(value) ?? '0';
}

/** Decimal major units ("12.34", 12.34) to integer minor units of `currency`, half away from zero. */
export function toMinor(
  value: string | number | null | undefined,
  currency: CurrencyCode,
): MinorUnits {
  const dec = toDecimalString(value);
  if (dec === null) return 0;
  return valueInMinor(dec, '1', currency);
}

/** Same as toMinor but null stays null. */
export function toMinorOrNull(
  value: string | number | null | undefined,
  currency: CurrencyCode,
): MinorUnits | null {
  return toDecimalString(value) === null ? null : toMinor(value, currency);
}

/** Integer already in minor units (Monobank, Teller sometimes) to a safe integer. */
export function asMinor(value: number | string | null | undefined): MinorUnits {
  const n = typeof value === 'string' ? Number(value) : (value ?? 0);
  return Math.round(n);
}

/** Absolute value that keeps -0 out of the data. */
export function absMinor(value: MinorUnits): MinorUnits {
  return Math.abs(value) || 0;
}

export function negate(value: MinorUnits): MinorUnits {
  return value === 0 ? 0 : -value;
}

export function absDecimal(value: DecimalString): DecimalString {
  return value.startsWith('-') ? value.slice(1) : value;
}

/** quantity x price as a decimal string (no rounding to minor units). */
export function multiplyDecimal(a: string | number, b: string | number): DecimalString {
  return mulDec(decimalOrZero(a), decimalOrZero(b));
}
