import type {
  ConnectorContext,
  CurrencyCode,
  DecimalString,
  ExchangeCode,
  IsoDateTime,
  LocalDate,
} from '@manaclaude/shared';

/** What to look up. `exchange` NSE or BSE selects an Indian listing. */
export interface SymbolRef {
  symbol: string;
  exchange?: ExchangeCode | null;
  /** Crypto pairs: "BTC" with kind crypto means BTC against `currency`. */
  kind?: 'equity' | 'crypto';
  /** Expected quote currency; used where the provider does not say. */
  currency?: CurrencyCode;
}

export interface Quote {
  symbol: string;
  exchange: ExchangeCode | null;
  price: DecimalString;
  currency: CurrencyCode;
  asOf: IsoDateTime;
  /** Provider id that answered. */
  source: string;
}

export interface DailyClose {
  symbol: string;
  date: LocalDate;
  close: DecimalString;
  currency: CurrencyCode;
}

/** A provider cannot price this symbol or exchange (Tiingo has no Indian listings). The fallback moves on. */
export class UnsupportedSymbolError extends Error {
  constructor(provider: string, ref: SymbolRef) {
    super(`${provider} does not cover ${ref.symbol}${ref.exchange ? ` on ${ref.exchange}` : ''}`);
    this.name = 'UnsupportedSymbolError';
  }
}

/** The provider knows the symbol exchange but has no data for it. */
export class SymbolNotFoundError extends Error {
  constructor(provider: string, ref: SymbolRef) {
    super(`${provider} has no data for ${ref.symbol}`);
    this.name = 'SymbolNotFoundError';
  }
}

export interface MarketDataProvider {
  id: string;
  quote(ctx: ConnectorContext, ref: SymbolRef): Promise<Quote>;
  history(
    ctx: ConnectorContext,
    ref: SymbolRef,
    from: LocalDate,
    to: LocalDate,
  ): Promise<DailyClose[]>;
}

/** Default quote currency for a listing when the provider does not name one. */
export function defaultCurrency(ref: SymbolRef): CurrencyCode {
  if (ref.currency) return ref.currency;
  switch (ref.exchange) {
    case 'NSE':
    case 'BSE':
      return 'INR';
    default:
      return 'USD';
  }
}
