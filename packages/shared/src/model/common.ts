/**
 * Primitive aliases used across the model.
 *
 * Money is always an integer count of the currency's minor unit (cents, paise)
 * plus an ISO 4217 currency code. Never store money as a float.
 */

/** ISO 4217 code, upper case: "USD", "INR", "EUR". */
export type CurrencyCode = string;

/**
 * Integer amount in the currency's minor unit: 1234 USD = $12.34, 1234 INR = Rs 12.34.
 * Use the helpers in `money/` to create, add and format these.
 */
export type MinorUnits = number;

/** A money value: integer minor units plus currency. */
export interface Money {
  amount: MinorUnits;
  currency: CurrencyCode;
}

/** Calendar date with no time zone: "2026-11-04". */
export type LocalDate = string;

/** Calendar month: "2026-11". */
export type YearMonth = string;

/** UTC timestamp in ISO 8601: "2026-11-04T18:30:00.000Z". */
export type IsoDateTime = string;

/**
 * Exact decimal as a string ("12.5", "0.00012345"). Used for share and coin
 * quantities and unit prices, which can have more decimals than money.
 * Do arithmetic with the helpers in `decimal/`.
 */
export type DecimalString = string;

/** Opaque id. Sample data uses readable prefixes ("acc_checking"); the backend may use UUIDs. */
export type Id = string;

/** Colour slot for categories, tags and goals. The active theme maps each slot to a real colour. */
export type ColorSlot = 'c1' | 'c2' | 'c3' | 'c4' | 'c5' | 'c6' | 'c7' | 'c8' | 'c9' | 'c10' | 'c11' | 'c12';

export const COLOR_SLOTS: readonly ColorSlot[] = [
  'c1',
  'c2',
  'c3',
  'c4',
  'c5',
  'c6',
  'c7',
  'c8',
  'c9',
  'c10',
  'c11',
  'c12',
];

/** Timestamps every stored record carries. */
export interface Timestamps {
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}
