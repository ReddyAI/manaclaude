import type { CurrencyCode, IsoDateTime, LocalDate } from './common';

export type FxRateSource =
  | 'openexchangerates'
  | 'frankfurter_ecb'
  | 'transfer_implied'
  | 'manual'
  | 'sample';

/**
 * 1 unit of `base` = `rate` units of `quote` (major units).
 * Open Exchange Rates gives USD-based rates; store Frankfurter rates with
 * base USD as well so lookups stay simple.
 */
export interface FxRate {
  base: CurrencyCode;
  quote: CurrencyCode;
  rate: number;
  /** When the provider published the rate. Show this next to converted totals. */
  asOf: IsoDateTime;
  /** Calendar day the rate is for (daily ECB history). */
  date: LocalDate;
  source: FxRateSource;
}
