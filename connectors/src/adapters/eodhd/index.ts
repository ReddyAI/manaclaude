import type { ConnectorContext, LocalDate } from '@manaclaude/shared';
import { HttpClient } from '../../http';
import { toLocalDate } from '../../util/dates';
import { toDecimalString } from '../../util/decimal';
import { appSecret, defineAdapter, emptyResult } from '../../kit';
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
 * EODHD (https://eodhd.com/financial-apis), a small free tier. Follows Sure:
 * app/models/provider/eodhd.rb.
 *
 * - Secrets: EODHD_API_KEY.
 * - Symbols are "<TICKER>.<EXCHANGE>": RELIANCE.NSE, TCS.BSE, AAPL.US, and
 *   crypto as "BTC-USD.CC". Prices come back without a currency, so the
 *   exchange decides it (INR for NSE and BSE, USD for US).
 * - Repair: 401/403 (key rejected).
 */

export const EODHD_API = 'https://eodhd.com/api';

export function eodhdSymbol(ref: SymbolRef): string {
  const s = ref.symbol.toUpperCase();
  if (ref.kind === 'crypto') return `${s}-${ref.currency ?? 'USD'}.CC`;
  return `${s}.${ref.exchange === 'NSE' || ref.exchange === 'BSE' ? ref.exchange : 'US'}`;
}

function client(ctx: ConnectorContext): HttpClient {
  return new HttpClient(ctx, { provider: 'EODHD', baseUrl: EODHD_API });
}

export const eodhdProvider: MarketDataProvider = {
  id: 'eodhd',
  async quote(ctx, ref): Promise<Quote> {
    const r = await client(ctx)
      .get<{ code?: string; timestamp?: number | string; close?: number | string }>(
        `/real-time/${encodeURIComponent(eodhdSymbol(ref))}`,
        { api_token: appSecret(ctx, 'EODHD_API_KEY', 'EODHD'), fmt: 'json' },
      )
      .catch((error: unknown) => {
        if (error instanceof Error && /HTTP 404/.test(error.message))
          throw new SymbolNotFoundError('EODHD', ref);
        throw error;
      });
    const price = toDecimalString(r?.close);
    if (!price) throw new ProviderDataError('EODHD', 'real-time');
    const ts = Number(r.timestamp);
    return {
      symbol: ref.symbol.toUpperCase(),
      exchange: ref.exchange ?? null,
      price,
      currency: defaultCurrency(ref),
      asOf:
        Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString() : ctx.now().toISOString(),
      source: 'eodhd',
    };
  },
  async history(ctx, ref, from: LocalDate, to: LocalDate): Promise<DailyClose[]> {
    const rows = await client(ctx).get<{ date: string; close: number }[]>(
      `/eod/${encodeURIComponent(eodhdSymbol(ref))}`,
      {
        from,
        to,
        period: 'd',
        order: 'a',
        api_token: appSecret(ctx, 'EODHD_API_KEY', 'EODHD'),
        fmt: 'json',
      },
    );
    return (Array.isArray(rows) ? rows : []).flatMap((p) => {
      const date = toLocalDate(p.date);
      const close = toDecimalString(p.close);
      return date && close
        ? [{ symbol: ref.symbol.toUpperCase(), date, close, currency: defaultCurrency(ref) }]
        : [];
    });
  },
};

export const eodhdAdapter = defineAdapter({
  id: 'eodhd',
  sync: async (ctx) => {
    await eodhdProvider.quote(ctx, { symbol: 'AAPL' });
    return emptyResult();
  },
  probe: async (ctx) => {
    await eodhdProvider.quote(ctx, { symbol: 'AAPL' });
  },
});
