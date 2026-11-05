import type { ConnectorContext, LocalDate } from '@manaclaude/shared';
import { HttpClient } from '../../http';
import { toLocalDate } from '../../util/dates';
import { toDecimalString } from '../../util/decimal';
import { toExchangeCode, defineAdapter, emptyResult } from '../../kit';
import {
  SymbolNotFoundError,
  defaultCurrency,
  type DailyClose,
  type MarketDataProvider,
  type Quote,
  type SymbolRef,
} from '../../market/types';
import { ProviderDataError } from '../../errors';

/**
 * Yahoo Finance chart endpoint (no key). Follows Sure: app/models/provider/yahoo_finance.rb.
 * The chart API is unofficial and can change or rate-limit without notice, which
 * is why it is the first choice only because it is free; Twelve Data, Tiingo and
 * EODHD are the fallbacks.
 *
 * - Indian listings: NSE is "<SYMBOL>.NS", BSE is "<SYMBOL>.BO". Toronto ".TO".
 *   Crypto is "<COIN>-<QUOTE>". Prices quoted in "GBp" (pence) become GBP.
 * - Secrets: none.
 */

export const YAHOO_API = 'https://query1.finance.yahoo.com';

export function yahooSymbol(ref: SymbolRef): string {
  const s = ref.symbol.toUpperCase();
  if (ref.kind === 'crypto') return `${s}-${ref.currency ?? 'USD'}`;
  if (ref.exchange === 'NSE') return `${s}.NS`;
  if (ref.exchange === 'BSE') return `${s}.BO`;
  if (ref.exchange === 'TSX') return `${s}.TO`;
  return s;
}

interface Chart {
  chart: {
    result?:
      | {
          meta: {
            currency?: string;
            symbol: string;
            regularMarketPrice?: number;
            regularMarketTime?: number;
            exchangeName?: string;
          };
          timestamp?: number[];
          indicators?: { quote?: { close?: (number | null)[] }[] };
        }[]
      | null;
    error?: { code?: string; description?: string } | null;
  };
}

function client(ctx: ConnectorContext): HttpClient {
  return new HttpClient(ctx, {
    provider: 'Yahoo Finance',
    baseUrl: YAHOO_API,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ManaClaude/1.0)' },
    repairStatuses: [],
  });
}

function pence(currency: string | undefined, value: number): { currency: string; value: number } {
  return currency === 'GBp' || currency === 'GBX'
    ? { currency: 'GBP', value: value / 100 }
    : { currency: (currency ?? 'USD').toUpperCase(), value };
}

async function chart(
  ctx: ConnectorContext,
  ref: SymbolRef,
  query: Record<string, string | number>,
): Promise<NonNullable<Chart['chart']['result']>[number]> {
  const resp = await client(ctx)
    .get<Chart>(`/v8/finance/chart/${encodeURIComponent(yahooSymbol(ref))}`, {
      interval: '1d',
      ...query,
    })
    .catch((error: unknown) => {
      if (error instanceof Error && /HTTP 404/.test(error.message))
        throw new SymbolNotFoundError('Yahoo Finance', ref);
      throw error;
    });
  const result = resp?.chart?.result?.[0];
  if (!result) {
    if (resp?.chart?.error) throw new SymbolNotFoundError('Yahoo Finance', ref);
    throw new ProviderDataError('Yahoo Finance', 'chart');
  }
  return result;
}

export const yahooFinanceProvider: MarketDataProvider = {
  id: 'yahoo_finance',
  async quote(ctx, ref): Promise<Quote> {
    const r = await chart(ctx, ref, { range: '5d' });
    const raw = r.meta.regularMarketPrice;
    if (raw === undefined) throw new SymbolNotFoundError('Yahoo Finance', ref);
    const p = pence(r.meta.currency, raw);
    return {
      symbol: ref.symbol.toUpperCase(),
      exchange: ref.exchange ?? toExchangeCode(r.meta.exchangeName),
      price: toDecimalString(p.value) ?? '0',
      currency: p.currency || defaultCurrency(ref),
      asOf: new Date(
        (r.meta.regularMarketTime ?? Math.floor(ctx.now().getTime() / 1000)) * 1000,
      ).toISOString(),
      source: 'yahoo_finance',
    };
  },
  async history(ctx, ref, from: LocalDate, to: LocalDate): Promise<DailyClose[]> {
    const toEpoch = (d: LocalDate, end = false): number =>
      Math.floor(Date.parse(`${d}T${end ? '23:59:59' : '00:00:00'}Z`) / 1000);
    const r = await chart(ctx, ref, { period1: toEpoch(from), period2: toEpoch(to, true) });
    const closes = r.indicators?.quote?.[0]?.close ?? [];
    const out: DailyClose[] = [];
    (r.timestamp ?? []).forEach((t, i) => {
      const close = closes[i];
      const date = toLocalDate(t);
      if (close === null || close === undefined || !date) return;
      const p = pence(r.meta.currency, close);
      out.push({
        symbol: ref.symbol.toUpperCase(),
        date,
        close: toDecimalString(p.value) ?? '0',
        currency: p.currency,
      });
    });
    return out;
  },
};

export const yahooFinanceAdapter = defineAdapter({
  id: 'yahoo_finance',
  // Market data has no accounts; sync only proves the service answers.
  sync: async (ctx) => {
    await yahooFinanceProvider.quote(ctx, { symbol: 'SPY' });
    return emptyResult();
  },
  probe: async (ctx) => {
    await yahooFinanceProvider.quote(ctx, { symbol: 'SPY' });
  },
});
