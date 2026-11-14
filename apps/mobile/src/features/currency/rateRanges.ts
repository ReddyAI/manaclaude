import {
  findRate,
  formatShortDate,
  type Account,
  type CurrencyCode,
  type FxRate,
  type LocalDate,
  type Transaction,
} from '@manaclaude/shared';
import { currencyNoRateText } from './missingRates';

/**
 * How far back the Worker's day rates go for each currency the app uses
 * (Settings, Exchange rates). Read from the dataset's fxRates; no route.
 *
 * A report converts a transaction with the rate on its day, or the nearest
 * one the Worker has: before the oldest rate, that oldest rate is used
 * (packages/shared/src/fx/convert.ts, pick).
 */

export interface RateRange {
  currency: CurrencyCode;
  /** Oldest and newest day with a rate between this currency and another; null when none. */
  from: LocalDate | null;
  to: LocalDate | null;
  /** Days with at least one rate. */
  days: number;
  /** The other currencies those rates are against. */
  against: CurrencyCode[];
  /** The oldest transaction in this currency, when a report needs it converted. */
  oldestTransaction: LocalDate | null;
  /** True when that transaction is older than the oldest rate. */
  olderThanRates: boolean;
  /** No rate converts it to the report currency (the case blocks L, M, O and R name). */
  noRate: boolean;
  /** True when it is the only currency reports use, so it needs no rate. */
  isReportCurrency: boolean;
}

export function rateRanges(
  data: {
    accounts: readonly Account[];
    transactions: readonly Transaction[];
    fxRates: readonly FxRate[];
  },
  reportCurrencies: readonly CurrencyCode[],
): RateRange[] {
  const main = reportCurrencies[0];
  const used = new Set<CurrencyCode>();
  for (const a of data.accounts) if (!a.hidden) used.add(a.currency);
  for (const t of data.transactions) used.add(t.currency);

  const oldest = new Map<CurrencyCode, LocalDate>();
  for (const t of data.transactions) {
    const seen = oldest.get(t.currency);
    if (!seen || t.date < seen) oldest.set(t.currency, t.date);
  }

  return [...used].sort().map((currency) => {
    const own = data.fxRates.filter((r) => r.base === currency || r.quote === currency);
    const dates = own.map((r) => r.date).sort();
    const from = dates[0] ?? null;
    const to = dates[dates.length - 1] ?? null;
    const against = [
      ...new Set(own.map((r) => (r.base === currency ? r.quote : r.base))),
    ].sort() as CurrencyCode[];
    const needsRate = reportCurrencies.some((r) => r !== currency);
    const first = needsRate ? (oldest.get(currency) ?? null) : null;
    return {
      currency,
      from,
      to,
      days: new Set(dates).size,
      against,
      oldestTransaction: first,
      olderThanRates: first !== null && from !== null && first < from,
      noRate: main !== undefined && findRate(data.fxRates, currency, main) === null,
      isReportCurrency: !needsRate,
    };
  });
}

/** "Jun 17, 2026": always with the year, since ranges can cross one. */
export function dateWithYear(date: LocalDate): string {
  return formatShortDate(date, '0000-01-01');
}

/** One line per currency, in plain words. */
export function rateRangeText(r: RateRange, reportCurrency: CurrencyCode): string {
  if (r.noRate) return currencyNoRateText(r.currency, reportCurrency);
  if (r.from === null || r.to === null) {
    return r.isReportCurrency
      ? `${r.currency}: reports are in ${r.currency}, so it needs no rate.`
      : `${r.currency}: no day rates stored.`;
  }
  const span =
    r.from === r.to
      ? `a rate for ${dateWithYear(r.from)} only`
      : `day rates from ${dateWithYear(r.from)} to ${dateWithYear(r.to)} (${r.days} ${r.days === 1 ? 'day' : 'days'})`;
  return `${r.currency}: ${span}, against ${r.against.join(', ')}.`;
}

/** Said when the oldest transaction is older than the oldest rate; null otherwise. */
export function olderThanRatesText(r: RateRange): string | null {
  if (!r.olderThanRates || r.oldestTransaction === null || r.from === null) return null;
  return `Your oldest ${r.currency} transaction is from ${dateWithYear(r.oldestTransaction)}, before the oldest ${r.currency} rate, so reports before ${dateWithYear(r.from)} use the ${dateWithYear(r.from)} rate.`;
}
