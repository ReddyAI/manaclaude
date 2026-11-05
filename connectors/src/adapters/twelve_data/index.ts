import type { ConnectorContext, LocalDate } from '@manaclaude/shared';
import { HttpClient } from '../../http';
import { toLocalDate } from '../../util/dates';
import { toDecimalString } from '../../util/decimal';
import { appSecret, defineAdapter, emptyResult, toExchangeCode } from '../../kit';
import {
  SymbolNotFoundError,
  defaultCurrency,
  type DailyClose,
  type MarketDataProvider,
  type Quote,
  type SymbolRef,
} from '../../market/types';
import {
  ProviderDataError,
  ProviderHttpError,
  repairNeeded,
  ConnectorRateLimitedError,
} from '../../errors';

/**
 * Twelve Data (https://twelvedata.com/docs), free key with a per-minute and
 * daily credit cap. Follows Sure: app/models/provider/twelve_data.rb.
 *
 * - Secrets: TWELVEDATA_API_KEY.
 * - Indian listings: symbol "RELIANCE" with exchange "NSE" or "BSE". Crypto is
 *   "BTC/USD".
 * - Twelve Data answers HTTP 200 with {code, message, status: "error"}; the code
 *   is read: 401 invalid key (repair), 429 credits used up (try later), 404 or
 *   400 unknown symbol.
 */

export const TWELVE_DATA_API = 'https://api.twelvedata.com';

function params(ref: SymbolRef): Record<string, string> {
  if (ref.kind === 'crypto')
    return { symbol: `${ref.symbol.toUpperCase()}/${ref.currency ?? 'USD'}` };
  return {
    symbol: ref.symbol.toUpperCase(),
    ...(ref.exchange === 'NSE' || ref.exchange === 'BSE' ? { exchange: ref.exchange } : {}),
  };
}

async function call<T extends { status?: string; code?: number; message?: string }>(
  ctx: ConnectorContext,
  path: string,
  ref: SymbolRef,
  extra: Record<string, string> = {},
): Promise<T> {
  const http = new HttpClient(ctx, {
    provider: 'Twelve Data',
    baseUrl: TWELVE_DATA_API,
    repairStatuses: [401, 403],
  });
  const resp = await http.get<T>(path, {
    ...params(ref),
    ...extra,
    apikey: appSecret(ctx, 'TWELVEDATA_API_KEY', 'Twelve Data'),
  });
  if (resp?.status === 'error') {
    if (resp.code === 401 || resp.code === 403)
      throw repairNeeded('Twelve Data', 'the API key was rejected');
    if (resp.code === 429) throw new ConnectorRateLimitedError('Twelve Data', 60);
    if (resp.code === 404 || resp.code === 400) throw new SymbolNotFoundError('Twelve Data', ref);
    throw new ProviderHttpError('Twelve Data', resp.code ?? 500, resp.message);
  }
  return resp;
}

export const twelveDataProvider: MarketDataProvider = {
  id: 'twelve_data',
  async quote(ctx, ref): Promise<Quote> {
    const q = await call<{
      symbol: string;
      exchange?: string;
      currency?: string;
      datetime?: string;
      close?: string;
      status?: string;
    }>(ctx, '/quote', ref);
    const price = toDecimalString(q.close);
    if (!price) throw new ProviderDataError('Twelve Data', 'quote');
    return {
      symbol: ref.symbol.toUpperCase(),
      exchange: ref.exchange ?? toExchangeCode(q.exchange),
      price,
      currency: (q.currency ?? defaultCurrency(ref)).toUpperCase(),
      asOf: q.datetime
        ? new Date(`${q.datetime.slice(0, 10)}T00:00:00Z`).toISOString()
        : ctx.now().toISOString(),
      source: 'twelve_data',
    };
  },
  async history(ctx, ref, from: LocalDate, to: LocalDate): Promise<DailyClose[]> {
    const r = await call<{
      meta?: { currency?: string };
      values?: { datetime: string; close: string }[];
      status?: string;
    }>(ctx, '/time_series', ref, {
      interval: '1day',
      start_date: from,
      end_date: to,
      order: 'ASC',
      outputsize: '5000',
    });
    const out: DailyClose[] = [];
    for (const v of r.values ?? []) {
      const date = toLocalDate(v.datetime);
      const close = toDecimalString(v.close);
      if (date && close)
        out.push({
          symbol: ref.symbol.toUpperCase(),
          date,
          close,
          currency: (r.meta?.currency ?? defaultCurrency(ref)).toUpperCase(),
        });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  },
};

export const twelveDataAdapter = defineAdapter({
  id: 'twelve_data',
  sync: async (ctx) => {
    await twelveDataProvider.quote(ctx, { symbol: 'AAPL' });
    return emptyResult();
  },
  probe: async (ctx) => {
    await twelveDataProvider.quote(ctx, { symbol: 'AAPL' });
  },
});
