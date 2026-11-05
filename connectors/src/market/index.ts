import type { ConnectorContext, LocalDate } from '@manaclaude/shared';
import { ConnectorConfigError, ConnectorRepairNeededError } from '../errors';
import {
  SymbolNotFoundError,
  UnsupportedSymbolError,
  type DailyClose,
  type MarketDataProvider,
  type Quote,
  type SymbolRef,
} from './types';

export * from './types';

export interface FallbackAttempt {
  provider: string;
  outcome: 'ok' | 'unsupported' | 'not_found' | 'no_key' | 'key_rejected' | 'error';
  message?: string;
}

export interface FallbackResult<T> {
  value: T | null;
  attempts: FallbackAttempt[];
}

/** Provider order from the brief: Yahoo Finance first, then Twelve Data, Tiingo, EODHD. */
export const MARKET_DATA_ORDER = ['yahoo_finance', 'twelve_data', 'tiingo', 'eodhd'] as const;

async function firstOf<T>(
  providers: readonly MarketDataProvider[],
  call: (p: MarketDataProvider) => Promise<T>,
  empty: (v: T) => boolean,
): Promise<FallbackResult<T>> {
  const attempts: FallbackAttempt[] = [];
  for (const p of providers) {
    try {
      const value = await call(p);
      if (empty(value)) {
        attempts.push({ provider: p.id, outcome: 'not_found', message: 'empty answer' });
        continue;
      }
      attempts.push({ provider: p.id, outcome: 'ok' });
      return { value, attempts };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'failed';
      const outcome: FallbackAttempt['outcome'] =
        error instanceof UnsupportedSymbolError
          ? 'unsupported'
          : error instanceof SymbolNotFoundError
            ? 'not_found'
            : error instanceof ConnectorConfigError
              ? 'no_key'
              : error instanceof ConnectorRepairNeededError
                ? 'key_rejected'
                : 'error';
      attempts.push({ provider: p.id, outcome, message });
    }
  }
  return { value: null, attempts };
}

/** Quote from the first provider that can answer. Never throws; `attempts` says why the others did not. */
export function quoteWithFallback(
  ctx: ConnectorContext,
  providers: readonly MarketDataProvider[],
  ref: SymbolRef,
): Promise<FallbackResult<Quote>> {
  return firstOf(
    providers,
    (p) => p.quote(ctx, ref),
    () => false,
  );
}

export function historyWithFallback(
  ctx: ConnectorContext,
  providers: readonly MarketDataProvider[],
  ref: SymbolRef,
  from: LocalDate,
  to: LocalDate,
): Promise<FallbackResult<DailyClose[]>> {
  return firstOf(
    providers,
    (p) => p.history(ctx, ref, from, to),
    (rows) => rows.length === 0,
  );
}
