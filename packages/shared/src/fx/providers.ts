import type { CurrencyCode, LocalDate, MinorUnits } from '../model/common';
import type { FxRate } from '../model/fx';
import type { TransferLink } from '../model/transaction';
import { convertAmount, convertMinor, transferRate, type RateQuery } from './convert';

/** Currencies stored by default. Account currencies are always added on top. */
export const DEFAULT_FX_QUOTES: readonly CurrencyCode[] = [
  'INR',
  'EUR',
  'GBP',
  'CAD',
  'AUD',
  'SGD',
  'AED',
  'JPY',
  'CHF',
];

interface OxrLatest {
  timestamp?: number;
  base?: string;
  rates?: Record<string, number>;
}

/**
 * Open Exchange Rates latest.json (free plan, USD base) to FxRate rows. The
 * day is the UTC date of the provider timestamp, so the hourly fetch keeps one
 * row per day per pair: the latest one.
 */
export function parseOpenExchangeRates(
  json: unknown,
  quotes: readonly CurrencyCode[],
): FxRate[] {
  const data = json as OxrLatest;
  if (!data || typeof data.timestamp !== 'number' || !data.rates) {
    throw new Error('Open Exchange Rates response has no timestamp or rates.');
  }
  const base = (data.base ?? 'USD').toUpperCase();
  const asOf = new Date(data.timestamp * 1000).toISOString();
  const date = asOf.slice(0, 10);
  return quotes
    .filter((q) => q !== base && typeof data.rates![q] === 'number' && data.rates![q]! > 0)
    .map((quote) => ({
      base,
      quote,
      rate: data.rates![quote]!,
      asOf,
      date,
      source: 'openexchangerates' as const,
    }));
}

interface FrankfurterLatest {
  base?: string;
  date?: string;
  rates?: Record<string, number> | Record<string, Record<string, number>>;
}

/** ECB publishes around 16:00 CET; we stamp daily rates at that time in UTC. */
function ecbAsOf(date: LocalDate): string {
  return `${date}T15:00:00.000Z`;
}

/**
 * Frankfurter (ECB reference rates) to FxRate rows with base USD. Accepts the
 * latest form ({date, rates: {INR: 88.1}}) and the time-series form
 * ({rates: {"2026-10-01": {INR: 88.1}}}). When the response base isn't USD,
 * rates are rebased through USD.
 */
export function parseFrankfurter(json: unknown, quotes: readonly CurrencyCode[]): FxRate[] {
  const data = json as FrankfurterLatest;
  if (!data || !data.rates) throw new Error('Frankfurter response has no rates.');
  const base = (data.base ?? 'USD').toUpperCase();
  const days: [LocalDate, Record<string, number>][] =
    data.date && !Object.values(data.rates).some((v) => typeof v === 'object')
      ? [[data.date, data.rates as Record<string, number>]]
      : Object.entries(data.rates as Record<string, Record<string, number>>);
  const out: FxRate[] = [];
  for (const [date, rates] of days) {
    const table: Record<string, number> = { ...rates, [base]: 1 };
    const usd = table.USD;
    if (!usd) continue;
    for (const quote of quotes) {
      if (quote === 'USD') continue;
      const q = table[quote];
      if (!q) continue;
      out.push({
        base: 'USD',
        quote,
        rate: q / usd,
        asOf: ecbAsOf(date),
        date,
        source: 'frankfurter_ecb',
      });
    }
  }
  return out;
}

/**
 * Converts one amount following the addendum's policy:
 * - a transaction in a linked cross-currency transfer uses the link's own rate
 * - otherwise the rate for the query (latest for balances, the day's rate for reports)
 */
export function convertWithPolicy(
  amount: MinorUnits,
  from: CurrencyCode,
  to: CurrencyCode,
  rates: readonly FxRate[],
  query: RateQuery,
  link?: TransferLink | null,
): MinorUnits | null {
  if (from === to) return amount;
  if (link) {
    const r = transferRate(link, from, to);
    if (r !== null) return convertMinor(amount, from, to, r);
  }
  return convertAmount(amount, from, to, rates, query);
}

/** Relative difference between two amounts in one currency (0.02 = 2%). */
export function relativeDifference(a: MinorUnits, b: MinorUnits): number {
  const big = Math.max(Math.abs(a), Math.abs(b));
  return big === 0 ? 0 : Math.abs(Math.abs(a) - Math.abs(b)) / big;
}
