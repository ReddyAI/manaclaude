import type { ConnectorContext, LocalDate } from '@manaclaude/shared';
import { addDays } from '@manaclaude/shared';
import { HttpClient } from '../../http';
import { todayUtc, toLocalDate } from '../../util/dates';
import { toDecimalString } from '../../util/decimal';
import { appSecret, defineAdapter, emptyResult } from '../../kit';
import {
  SymbolNotFoundError,
  UnsupportedSymbolError,
  type DailyClose,
  type MarketDataProvider,
  type Quote,
  type SymbolRef,
} from '../../market/types';

/**
 * Tiingo (https://www.tiingo.com/documentation), free token. Follows Sure:
 * app/models/provider/tiingo.rb. Tiingo covers US listings and crypto; it has
 * no NSE or BSE data, so Indian symbols are skipped and the fallback moves on.
 *
 * - Secrets: TIINGO_API_TOKEN.
 * - Prices are in USD. Crypto uses "<coin><quote>" in lower case (btcusd).
 * - Repair: 401/403.
 */

export const TIINGO_API = 'https://api.tiingo.com';

function guard(ref: SymbolRef): void {
  if (ref.exchange === 'NSE' || ref.exchange === 'BSE')
    throw new UnsupportedSymbolError('Tiingo', ref);
}

function client(ctx: ConnectorContext): HttpClient {
  return new HttpClient(ctx, {
    provider: 'Tiingo',
    baseUrl: TIINGO_API,
    headers: { Authorization: `Token ${appSecret(ctx, 'TIINGO_API_TOKEN', 'Tiingo')}` },
  });
}

async function daily(
  ctx: ConnectorContext,
  ref: SymbolRef,
  from: LocalDate,
  to: LocalDate,
): Promise<{ date: LocalDate; close: string }[]> {
  guard(ref);
  const http = client(ctx);
  if (ref.kind === 'crypto') {
    const r = await http.get<{ priceData?: { date: string; close: number }[] }[]>(
      '/tiingo/crypto/prices',
      {
        tickers: `${ref.symbol.toLowerCase()}${(ref.currency ?? 'USD').toLowerCase()}`,
        startDate: from,
        endDate: to,
        resampleFreq: '1day',
      },
    );
    return (r?.[0]?.priceData ?? []).flatMap((p) => {
      const date = toLocalDate(p.date);
      const close = toDecimalString(p.close);
      return date && close ? [{ date, close }] : [];
    });
  }
  const rows = await http
    .get<{ date: string; close: number }[]>(
      `/tiingo/daily/${encodeURIComponent(ref.symbol.toLowerCase())}/prices`,
      { startDate: from, endDate: to },
    )
    .catch((error: unknown) => {
      if (error instanceof Error && /HTTP 404/.test(error.message))
        throw new SymbolNotFoundError('Tiingo', ref);
      throw error;
    });
  return (Array.isArray(rows) ? rows : []).flatMap((p) => {
    const date = toLocalDate(p.date);
    const close = toDecimalString(p.close);
    return date && close ? [{ date, close }] : [];
  });
}

export const tiingoProvider: MarketDataProvider = {
  id: 'tiingo',
  async quote(ctx, ref): Promise<Quote> {
    const today = todayUtc(ctx.now());
    const rows = await daily(ctx, ref, addDays(today, -7), today);
    const last = rows[rows.length - 1];
    if (!last) throw new SymbolNotFoundError('Tiingo', ref);
    return {
      symbol: ref.symbol.toUpperCase(),
      exchange: ref.exchange ?? null,
      price: last.close,
      currency: 'USD',
      asOf: `${last.date}T00:00:00.000Z`,
      source: 'tiingo',
    };
  },
  async history(ctx, ref, from, to): Promise<DailyClose[]> {
    return (await daily(ctx, ref, from, to)).map((r) => ({
      symbol: ref.symbol.toUpperCase(),
      date: r.date,
      close: r.close,
      currency: 'USD',
    }));
  },
};

export const tiingoAdapter = defineAdapter({
  id: 'tiingo',
  sync: async (ctx) => {
    await tiingoProvider.quote(ctx, { symbol: 'AAPL' });
    return emptyResult();
  },
  probe: async (ctx) => {
    await tiingoProvider.quote(ctx, { symbol: 'AAPL' });
  },
});
