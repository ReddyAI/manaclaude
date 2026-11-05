import type { CurrencyCode, DecimalString, Id, LocalDate, MinorUnits } from '../model/common';
import type {
  Holding,
  InvestmentActivity,
  PricePoint,
  RealizedGain,
  Security,
  TaxLot,
} from '../model/investment';
import { addDec, decToNumber, mulDec, subDec } from '../money/decimal';
import { toMajor } from '../money/money';
import { deriveLotsFifo, lotPerformance, type LotMethod, type LotPerformance } from './lots';

/**
 * Investment numbers the screens share: position summaries, realized gains,
 * dividends, allocation and the S&P 500 benchmark. Pure functions; amounts stay
 * in the currency of the security (convert at the edge with useMoneyDisplay).
 */

export interface PositionLot {
  lot: TaxLot;
  perf: LotPerformance;
}

export interface PositionSummary {
  holdingId: Id;
  quantity: DecimalString;
  marketValue: MinorUnits;
  /** Sum of the open lots' cost; falls back to the holding's own cost basis when it has no lots. */
  costBasis: MinorUnits;
  unrealized: MinorUnits;
  /** unrealized / costBasis; null when the cost basis is 0. */
  unrealizedPct: number | null;
  shortTermUnrealized: MinorUnits;
  longTermUnrealized: MinorUnits;
  lots: PositionLot[];
  lotSource: 'broker' | 'derived' | 'none';
}

export function summarizePosition(
  holding: Holding,
  lots: readonly TaxLot[],
  today: LocalDate,
): PositionSummary {
  const own = lots
    .filter((l) => l.holdingId === holding.id)
    .sort((a, b) => a.acquiredOn.localeCompare(b.acquiredOn));
  const rows = own.map((lot) => ({ lot, perf: lotPerformance(lot, holding.price, today) }));
  const costBasis =
    own.length > 0 ? own.reduce((s, l) => s + l.costBasis, 0) : (holding.costBasis ?? 0);
  const unrealized = holding.marketValue - costBasis;
  const sum = (term: 'short' | 'long') =>
    rows.filter((r) => r.perf.term === term).reduce((s, r) => s + r.perf.gain, 0);
  return {
    holdingId: holding.id,
    quantity: holding.quantity,
    marketValue: holding.marketValue,
    costBasis,
    unrealized,
    unrealizedPct: costBasis === 0 ? null : unrealized / costBasis,
    shortTermUnrealized: sum('short'),
    longTermUnrealized: sum('long'),
    lots: rows,
    lotSource: own.length === 0 ? 'none' : own[0]!.source,
  };
}

export interface DividendRecord {
  date: LocalDate;
  accountId: Id;
  securityId: Id | null;
  type: 'dividend' | 'interest';
  amount: MinorUnits;
  currency: CurrencyCode;
}

export interface ActivityResults {
  realized: RealizedGain[];
  dividends: DividendRecord[];
  warnings: string[];
}

/**
 * Run lot derivation for every account and security that has activities and
 * collect the realized gains and dividends. Holdings whose lots come from the
 * broker are not touched here; they have no activities to replay.
 */
export function resultsFromActivities(
  activities: readonly InvestmentActivity[],
  method: LotMethod = 'fifo',
): ActivityResults {
  const groups = new Map<string, InvestmentActivity[]>();
  const dividends: DividendRecord[] = [];
  for (const a of activities) {
    if (a.type === 'dividend' || a.type === 'interest') {
      dividends.push({
        date: a.date,
        accountId: a.accountId,
        securityId: a.securityId,
        type: a.type,
        amount: a.amount,
        currency: a.currency,
      });
    }
    if (a.securityId === null) continue;
    const key = `${a.accountId}|${a.securityId}`;
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  const realized: RealizedGain[] = [];
  const warnings: string[] = [];
  for (const [key, acts] of groups) {
    const [accountId = '', securityId = ''] = key.split('|');
    const result = deriveLotsFifo({
      activities: acts,
      holdingId: `${accountId}_${securityId}`,
      accountId,
      securityId,
      currency: acts[0]?.currency ?? 'USD',
      method,
    });
    realized.push(...result.realized);
    warnings.push(...result.warnings);
  }
  realized.sort((a, b) => b.soldOn.localeCompare(a.soldOn));
  dividends.sort((a, b) => b.date.localeCompare(a.date));
  return { realized, dividends, warnings };
}

export interface RealizedTotals {
  proceeds: MinorUnits;
  costBasis: MinorUnits;
  gain: MinorUnits;
  shortTermGain: MinorUnits;
  longTermGain: MinorUnits;
}

/** Totals for pieces already converted into one currency by `valueOf`. */
export function summarizeRealized(
  realized: readonly RealizedGain[],
  options: { year?: number; convert?: (amount: MinorUnits, gain: RealizedGain) => MinorUnits } = {},
): RealizedTotals {
  const valueOf = options.convert ?? ((amount: MinorUnits) => amount);
  const totals: RealizedTotals = {
    proceeds: 0,
    costBasis: 0,
    gain: 0,
    shortTermGain: 0,
    longTermGain: 0,
  };
  for (const r of realized) {
    if (options.year !== undefined && Number(r.soldOn.slice(0, 4)) !== options.year) continue;
    const gain = valueOf(r.gain, r);
    totals.proceeds += valueOf(r.proceeds, r);
    totals.costBasis += valueOf(r.costBasis, r);
    totals.gain += gain;
    if (r.term === 'long') totals.longTermGain += gain;
    else totals.shortTermGain += gain;
  }
  return totals;
}

/** Dividend and interest income summed per calendar year, newest year first. */
export function dividendsByYear(
  dividends: readonly DividendRecord[],
  valueOf: (d: DividendRecord) => MinorUnits = (d) => d.amount,
): { year: number; amount: MinorUnits }[] {
  const byYear = new Map<number, number>();
  for (const d of dividends) {
    const year = Number(d.date.slice(0, 4));
    byYear.set(year, (byYear.get(year) ?? 0) + valueOf(d));
  }
  return [...byYear.entries()]
    .map(([year, amount]) => ({ year, amount }))
    .sort((a, b) => b.year - a.year);
}

export type AssetClass = Security['assetClass'];

/** Market value per asset class, largest first. `valueOf` converts a holding to the report currency. */
export function allocationByClass(
  holdings: readonly Holding[],
  securities: readonly Security[],
  valueOf: (holding: Holding) => MinorUnits,
): { assetClass: AssetClass; value: MinorUnits; share: number }[] {
  const byId = new Map(securities.map((s) => [s.id, s]));
  const totals = new Map<AssetClass, number>();
  for (const h of holdings) {
    const cls = byId.get(h.securityId)?.assetClass ?? 'other';
    totals.set(cls, (totals.get(cls) ?? 0) + valueOf(h));
  }
  const sum = [...totals.values()].reduce((s, v) => s + v, 0);
  return [...totals.entries()]
    .map(([assetClass, value]) => ({ assetClass, value, share: sum === 0 ? 0 : value / sum }))
    .sort((a, b) => b.value - a.value);
}

/** Units held after replaying the activities up to and including `date`, splits applied. */
export function quantityAt(
  activities: readonly InvestmentActivity[],
  date: LocalDate,
): DecimalString {
  const ordered = activities
    .filter((a) => a.date <= date)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.type === 'split' ? -1 : 0));
  let qty: DecimalString = '0';
  for (const a of ordered) {
    if (a.type === 'buy' || a.type === 'reinvest' || a.type === 'transfer_in') {
      if (a.quantity) qty = addDec(qty, a.quantity);
    } else if (a.type === 'sell' || a.type === 'transfer_out') {
      if (a.quantity) qty = subDec(qty, a.quantity);
    } else if (a.type === 'split' && a.splitRatio) {
      qty = mulDec(qty, a.splitRatio);
    }
  }
  return qty;
}

/** Close on or before `date`; the oldest close when the date is before all of them. */
export function priceOnOrBefore(
  prices: readonly PricePoint[],
  securityId: Id,
  date: LocalDate,
): number | null {
  let best: PricePoint | null = null;
  let oldest: PricePoint | null = null;
  for (const p of prices) {
    if (p.securityId !== securityId) continue;
    if (!oldest || p.date < oldest.date) oldest = p;
    if (p.date <= date && (!best || p.date > best.date)) best = p;
  }
  const found = best ?? oldest;
  return found ? decToNumber(found.close) : null;
}

export interface BenchmarkPoint {
  date: LocalDate;
  /** Value of the portfolio (accounts with activity history), in major units of the report currency. */
  portfolio: number;
  /** The same money, and the same buys and sells, put into the benchmark instead. */
  benchmark: number;
}

export interface BenchmarkResult {
  points: BenchmarkPoint[];
  /** Portfolio gain over the period, not counting money added or taken out. */
  portfolioGain: number;
  benchmarkGain: number;
  /** portfolioGain - benchmarkGain; positive means the portfolio beat the benchmark. */
  difference: number;
  /** Net money added (buys minus sells) during the period. */
  netInvested: number;
}

export interface BenchmarkInput {
  activities: readonly InvestmentActivity[];
  prices: readonly PricePoint[];
  benchmarkSecurityId: Id;
  /** Dates to sample, oldest first (for example the benchmark's own price dates). */
  dates: readonly LocalDate[];
  /** Major units of the report currency per 1 major unit of `currency`; null when unknown. */
  fx: (currency: CurrencyCode) => number | null;
}

/**
 * Compare the portfolio with putting the same money into the S&P 500: at the
 * first date the whole portfolio value goes into the benchmark, and every later
 * buy or sell moves the same cash in or out of it. Price return only.
 */
export function benchmarkComparison(input: BenchmarkInput): BenchmarkResult {
  const { activities, prices, benchmarkSecurityId, dates, fx } = input;
  const empty: BenchmarkResult = {
    points: [],
    portfolioGain: 0,
    benchmarkGain: 0,
    difference: 0,
    netInvested: 0,
  };
  if (dates.length < 2) return empty;

  const bySecurity = new Map<string, InvestmentActivity[]>();
  for (const a of activities) {
    if (a.securityId === null) continue;
    const key = `${a.accountId}|${a.securityId}`;
    bySecurity.set(key, [...(bySecurity.get(key) ?? []), a]);
  }

  const portfolioAt = (date: LocalDate): number => {
    let total = 0;
    for (const [key, acts] of bySecurity) {
      const securityId = key.split('|')[1] ?? '';
      const price = priceOnOrBefore(prices, securityId, date);
      const rate = fx(acts[0]?.currency ?? 'USD');
      if (price === null || rate === null) continue;
      total += decToNumber(quantityAt(acts, date)) * price * rate;
    }
    return total;
  };

  const flowsBetween = (from: LocalDate, to: LocalDate): number => {
    let net = 0;
    for (const a of activities) {
      if (a.date <= from || a.date > to) continue;
      if (a.type !== 'buy' && a.type !== 'sell') continue;
      const rate = fx(a.currency);
      if (rate === null) continue;
      // buy: amount < 0 means cash went into the portfolio
      net += toMajor(-a.amount, a.currency) * rate;
    }
    return net;
  };

  const first = dates[0]!;
  const start = portfolioAt(first);
  const benchStart = priceOnOrBefore(prices, benchmarkSecurityId, first);
  if (benchStart === null || benchStart === 0) return empty;
  let benchUnits = start / benchStart;
  let netInvested = 0;
  const points: BenchmarkPoint[] = [{ date: first, portfolio: start, benchmark: start }];
  for (let i = 1; i < dates.length; i += 1) {
    const prev = dates[i - 1]!;
    const date = dates[i]!;
    const flow = flowsBetween(prev, date);
    const benchPrice = priceOnOrBefore(prices, benchmarkSecurityId, date);
    if (benchPrice === null || benchPrice === 0) continue;
    // Flows happen at the new date's price, a simplification for monthly sampling.
    benchUnits += flow / benchPrice;
    netInvested += flow;
    points.push({ date, portfolio: portfolioAt(date), benchmark: benchUnits * benchPrice });
  }
  const last = points[points.length - 1]!;
  const portfolioGain = last.portfolio - start - netInvested;
  const benchmarkGain = last.benchmark - start - netInvested;
  return {
    points,
    portfolioGain,
    benchmarkGain,
    difference: portfolioGain - benchmarkGain,
    netInvested,
  };
}
