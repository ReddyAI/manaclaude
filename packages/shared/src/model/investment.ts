import type {
  CurrencyCode,
  DecimalString,
  Id,
  IsoDateTime,
  LocalDate,
  MinorUnits,
} from './common';

export type SecurityType =
  | 'equity'
  | 'etf'
  | 'mutual_fund'
  | 'bond'
  | 'crypto'
  | 'cash'
  | 'option'
  | 'other';

/** Exchange code. NSE and BSE cover Indian securities. */
export type ExchangeCode =
  | 'NASDAQ'
  | 'NYSE'
  | 'ARCA'
  | 'BATS'
  | 'NSE'
  | 'BSE'
  | 'CRYPTO'
  | 'OTC'
  | (string & {});

export interface Security {
  id: Id;
  symbol: string;
  name: string;
  type: SecurityType;
  exchange: ExchangeCode | null;
  currency: CurrencyCode;
  isin: string | null;
  /** Asset class for allocation charts. */
  assetClass: 'us_stocks' | 'intl_stocks' | 'india_stocks' | 'bonds' | 'crypto' | 'cash' | 'other';
  /** The benchmark (S&P 500 index fund) used for comparison charts. */
  isBenchmark: boolean;
}

/** A position in one security in one account. */
export interface Holding {
  id: Id;
  accountId: Id;
  securityId: Id;
  quantity: DecimalString;
  /** Latest price per unit in `currency`. */
  price: DecimalString;
  priceAsOf: IsoDateTime;
  /** quantity x price, in minor units of `currency`. */
  marketValue: MinorUnits;
  /** Total cost basis of the open lots, when known. */
  costBasis: MinorUnits | null;
  currency: CurrencyCode;
  source: 'connector' | 'derived' | 'manual';
}

/**
 * One open tax lot: shares bought on one date that are still held.
 * From the broker when it provides lots (Plaid tax_lots), otherwise derived
 * from buy/sell activities (FIFO by default; see investments/lots.ts).
 */
export interface TaxLot {
  id: Id;
  holdingId: Id;
  acquiredOn: LocalDate;
  /** Units still held in this lot. */
  quantity: DecimalString;
  /** Total cost of the units still held, in minor units of `currency`. */
  costBasis: MinorUnits;
  currency: CurrencyCode;
  source: 'broker' | 'derived';
  externalId: string | null;
}

export type InvestmentActivityType =
  | 'buy'
  | 'sell'
  | 'dividend'
  | 'interest'
  | 'split'
  | 'transfer_in'
  | 'transfer_out'
  | 'reinvest'
  | 'fee'
  | 'contribution'
  | 'withdrawal';

export interface InvestmentActivity {
  id: Id;
  accountId: Id;
  securityId: Id | null;
  type: InvestmentActivityType;
  date: LocalDate;
  /** Units bought, sold or moved (positive). null for cash-only activities. */
  quantity: DecimalString | null;
  /** Price per unit. */
  price: DecimalString | null;
  /**
   * Net cash effect on the account, signed: buy negative (cost including fees),
   * sell positive (proceeds after fees), dividend positive.
   */
  amount: MinorUnits;
  fees: MinorUnits;
  currency: CurrencyCode;
  /** Splits: new units per old unit ("4" for a 4-for-1 split, "0.1" for 1-for-10). */
  splitRatio: DecimalString | null;
  externalId: string | null;
  source: 'connector' | 'import' | 'manual';
}

/** One closed piece of a lot, produced by a sell. */
export interface RealizedGain {
  accountId: Id;
  securityId: Id;
  acquiredOn: LocalDate;
  soldOn: LocalDate;
  quantity: DecimalString;
  proceeds: MinorUnits;
  costBasis: MinorUnits;
  gain: MinorUnits;
  currency: CurrencyCode;
  /** Held more than one year. */
  term: 'short' | 'long';
}

export interface PricePoint {
  securityId: Id;
  date: LocalDate;
  close: DecimalString;
  currency: CurrencyCode;
}
