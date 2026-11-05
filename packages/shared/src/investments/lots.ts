import type { CurrencyCode, DecimalString, Id, LocalDate, MinorUnits } from '../model/common';
import type { InvestmentActivity, RealizedGain, TaxLot } from '../model/investment';
import { addMonths } from '../dates/dates';
import {
  cmpDec,
  isZeroDec,
  minDec,
  mulDec,
  proRateMinor,
  subDec,
  valueInMinor,
} from '../money/decimal';

/**
 * Derive open tax lots and realized gains from buy/sell activities, first in
 * first out. Used when the broker doesn't provide lots (SnapTrade) and by the
 * investments screens. Session C owns this file; session D calls it.
 */

export interface DeriveLotsInput {
  /** Activities for ONE account and ONE security, any order. */
  activities: readonly InvestmentActivity[];
  holdingId: Id;
  accountId: Id;
  securityId: Id;
  currency: CurrencyCode;
}

export interface DeriveLotsResult {
  lots: TaxLot[];
  realized: RealizedGain[];
  dividends: MinorUnits;
  warnings: string[];
}

interface WorkingLot {
  acquiredOn: LocalDate;
  quantity: DecimalString;
  costBasis: MinorUnits;
}

/** Held more than one year (US rule; India's equity rule is also 12 months). */
export function holdingTerm(acquiredOn: LocalDate, soldOn: LocalDate): 'short' | 'long' {
  return soldOn > addMonths(acquiredOn, 12) ? 'long' : 'short';
}

const ORDER: Record<InvestmentActivity['type'], number> = {
  split: 0,
  transfer_in: 1,
  buy: 2,
  reinvest: 2,
  sell: 3,
  transfer_out: 3,
  dividend: 4,
  interest: 4,
  fee: 4,
  contribution: 4,
  withdrawal: 4,
};

export function deriveLotsFifo(input: DeriveLotsInput): DeriveLotsResult {
  const warnings: string[] = [];
  const realized: RealizedGain[] = [];
  let dividends = 0;
  const open: WorkingLot[] = [];

  const sorted = input.activities
    .map((a, i) => ({ a, i }))
    .sort(
      (x, y) => x.a.date.localeCompare(y.a.date) || ORDER[x.a.type] - ORDER[y.a.type] || x.i - y.i,
    )
    .map((x) => x.a);

  for (const act of sorted) {
    switch (act.type) {
      case 'buy':
      case 'reinvest':
      case 'transfer_in': {
        if (!act.quantity || isZeroDec(act.quantity)) {
          warnings.push(`${act.id}: ${act.type} without a quantity was skipped`);
          break;
        }
        let cost = -act.amount;
        if (act.type === 'transfer_in' && act.amount === 0) {
          cost = act.price ? valueInMinor(act.quantity, act.price, input.currency) : 0;
          if (!act.price) warnings.push(`${act.id}: transfer in has no cost basis; using 0`);
        }
        open.push({ acquiredOn: act.date, quantity: act.quantity, costBasis: cost });
        break;
      }
      case 'sell':
      case 'transfer_out': {
        if (!act.quantity) {
          warnings.push(`${act.id}: ${act.type} without a quantity was skipped`);
          break;
        }
        let remaining = act.quantity;
        const totalQty = act.quantity;
        let proceedsLeft = act.type === 'sell' ? act.amount : 0;
        while (!isZeroDec(remaining) && open.length > 0) {
          const lot = open[0]!;
          const take = minDec(remaining, lot.quantity);
          const lotCost =
            cmpDec(take, lot.quantity) === 0
              ? lot.costBasis
              : proRateMinor(lot.costBasis, take, lot.quantity);
          const afterTake = subDec(remaining, take);
          // Last piece of the sell gets whatever proceeds are left, so the pieces add up exactly.
          const proceeds =
            isZeroDec(afterTake) || open.length === 1
              ? proceedsLeft
              : proRateMinor(act.type === 'sell' ? act.amount : 0, take, totalQty);
          if (act.type === 'sell') {
            realized.push({
              accountId: input.accountId,
              securityId: input.securityId,
              acquiredOn: lot.acquiredOn,
              soldOn: act.date,
              quantity: take,
              proceeds,
              costBasis: lotCost,
              gain: proceeds - lotCost,
              currency: input.currency,
              term: holdingTerm(lot.acquiredOn, act.date),
            });
            proceedsLeft -= proceeds;
          }
          lot.quantity = subDec(lot.quantity, take);
          lot.costBasis -= lotCost;
          if (isZeroDec(lot.quantity)) open.shift();
          remaining = afterTake;
        }
        if (!isZeroDec(remaining)) {
          warnings.push(`${act.id}: sold ${remaining} more units than the lots hold`);
        }
        break;
      }
      case 'split': {
        if (!act.splitRatio) {
          warnings.push(`${act.id}: split without a ratio was skipped`);
          break;
        }
        for (const lot of open) lot.quantity = mulDec(lot.quantity, act.splitRatio);
        break;
      }
      case 'dividend':
        dividends += act.amount;
        break;
      default:
        break;
    }
  }

  const lots: TaxLot[] = open.map((lot, i) => ({
    id: `${input.holdingId}_lot${i + 1}`,
    holdingId: input.holdingId,
    acquiredOn: lot.acquiredOn,
    quantity: lot.quantity,
    costBasis: lot.costBasis,
    currency: input.currency,
    source: 'derived',
    externalId: null,
  }));

  return { lots, realized, dividends, warnings };
}

export interface LotPerformance {
  marketValue: MinorUnits;
  gain: MinorUnits;
  /** gain / cost basis, as a fraction (0.12 = 12%). null when cost basis is 0. */
  gainPct: number | null;
  term: 'short' | 'long';
}

/** Unrealized gain of one lot at a price. */
export function lotPerformance(
  lot: TaxLot,
  price: DecimalString,
  today: LocalDate,
): LotPerformance {
  const marketValue = valueInMinor(lot.quantity, price, lot.currency);
  const gain = marketValue - lot.costBasis;
  return {
    marketValue,
    gain,
    gainPct: lot.costBasis === 0 ? null : gain / lot.costBasis,
    term: holdingTerm(lot.acquiredOn, today),
  };
}
