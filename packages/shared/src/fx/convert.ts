import type { CurrencyCode, IsoDateTime, LocalDate, MinorUnits } from '../model/common';
import type { FxRate } from '../model/fx';
import type { TransferLink } from '../model/transaction';
import { minorDigits } from '../money/currencies';
import { roundHalfAwayFromZero } from '../money/money';

/**
 * Basic conversion helper (foundation version). Session B owns this file and
 * extends it; keep the exported signatures stable.
 *
 * Policy from the addendum:
 * - balances and net worth use the latest rate      -> { mode: 'latest' }
 * - spending reports use the rate on the txn's date -> { mode: 'on', date }
 * - a linked cross-currency transfer uses its own implied rate -> transferRate()
 */

export interface ResolvedRate {
  rate: number;
  asOf: IsoDateTime;
  source: FxRate['source'];
}

export type RateQuery = { mode: 'latest' } | { mode: 'on'; date: LocalDate };

interface PairIndex {
  /** All rates for base->quote, newest date first. */
  byPair: Map<string, FxRate[]>;
}

const indexCache = new WeakMap<readonly FxRate[], PairIndex>();

function pairKey(base: string, quote: string): string {
  return `${base}>${quote}`;
}

function indexRates(rates: readonly FxRate[]): PairIndex {
  const cached = indexCache.get(rates);
  if (cached) return cached;
  const byPair = new Map<string, FxRate[]>();
  for (const r of rates) {
    const key = pairKey(r.base, r.quote);
    const list = byPair.get(key) ?? [];
    list.push(r);
    byPair.set(key, list);
  }
  for (const list of byPair.values()) {
    list.sort((a, b) => (a.date === b.date ? b.asOf.localeCompare(a.asOf) : b.date.localeCompare(a.date)));
  }
  const index = { byPair };
  indexCache.set(rates, index);
  return index;
}

function pick(list: FxRate[] | undefined, query: RateQuery): FxRate | null {
  if (!list || list.length === 0) return null;
  if (query.mode === 'latest') return list[0] ?? null;
  // Newest rate on or before the date; fall back to the oldest one we have.
  for (const r of list) {
    if (r.date <= query.date) return r;
  }
  return list[list.length - 1] ?? null;
}

/**
 * Rate to turn 1 unit of `from` into `to`. Looks for a direct pair, its
 * inverse, then crosses through USD (rates are stored with base USD).
 */
export function findRate(
  rates: readonly FxRate[],
  from: CurrencyCode,
  to: CurrencyCode,
  query: RateQuery = { mode: 'latest' },
): ResolvedRate | null {
  if (from === to) return { rate: 1, asOf: new Date(0).toISOString(), source: 'manual' };
  const { byPair } = indexRates(rates);
  const direct = pick(byPair.get(pairKey(from, to)), query);
  if (direct) return { rate: direct.rate, asOf: direct.asOf, source: direct.source };
  const inverse = pick(byPair.get(pairKey(to, from)), query);
  if (inverse && inverse.rate !== 0) {
    return { rate: 1 / inverse.rate, asOf: inverse.asOf, source: inverse.source };
  }
  for (const pivot of ['USD', 'EUR']) {
    if (pivot === from || pivot === to) continue;
    const a = pick(byPair.get(pairKey(pivot, from)), query);
    const b = pick(byPair.get(pairKey(pivot, to)), query);
    if (a && b && a.rate !== 0) {
      const asOf = a.asOf < b.asOf ? a.asOf : b.asOf;
      return { rate: b.rate / a.rate, asOf, source: b.source };
    }
  }
  return null;
}

/** Convert minor units with a known rate, handling different minor digits. */
export function convertMinor(
  amount: MinorUnits,
  from: CurrencyCode,
  to: CurrencyCode,
  rate: number,
): MinorUnits {
  if (from === to) return amount;
  const scale = 10 ** (minorDigits(to) - minorDigits(from));
  return roundHalfAwayFromZero(amount * rate * scale);
}

/** Convert with a rate looked up from the table; null when no rate exists. */
export function convertAmount(
  amount: MinorUnits,
  from: CurrencyCode,
  to: CurrencyCode,
  rates: readonly FxRate[],
  query: RateQuery = { mode: 'latest' },
): MinorUnits | null {
  if (from === to) return amount;
  const r = findRate(rates, from, to, query);
  return r ? convertMinor(amount, from, to, r.rate) : null;
}

/** The rate a linked transfer actually got, for converting between its two currencies. */
export function transferRate(link: TransferLink, from: CurrencyCode, to: CurrencyCode): number | null {
  if (from === link.outCurrency && to === link.inCurrency) return link.impliedRate;
  if (from === link.inCurrency && to === link.outCurrency && link.impliedRate !== 0) {
    return 1 / link.impliedRate;
  }
  return null;
}

/** inAmount per outAmount in major units, from the two stored minor amounts. */
export function impliedRateOf(
  outAmount: MinorUnits,
  outCurrency: CurrencyCode,
  inAmount: MinorUnits,
  inCurrency: CurrencyCode,
): number {
  if (outAmount === 0) return 0;
  const outMajor = Math.abs(outAmount) / 10 ** minorDigits(outCurrency);
  const inMajor = Math.abs(inAmount) / 10 ** minorDigits(inCurrency);
  return inMajor / outMajor;
}
