import type { Connection, ConnectorContext, ProviderHolding, SyncResult } from '@manaclaude/shared';
import { HttpClient } from '../../http';
import { sinceCursor } from '../../util/cursor';
import { todayUtc, toLocalDate } from '../../util/dates';
import { absDecimal, negate, toDecimalString, toMinor } from '../../util/decimal';
import {
  basicAuth,
  connectionSecret,
  defineAdapter,
  emptyResult,
  optionalSecret,
  providerAccount,
} from '../../kit';
import { ConnectorRateLimitedError, ProviderDataError } from '../../errors';

/**
 * Trading 212 public API (https://docs.trading212.com), personal key.
 * Follows Sure: app/models/provider/trading212.rb (Basic auth with key and
 * secret, summary, positions, paged history with nextPagePath, 6 requests a
 * minute on history) and trading212_account/{holdings,activities,data_helpers}.rb
 * (ticker cleanup, GBX pence to GBP, FILLED orders only).
 *
 * - Secrets: T212_API_KEY and T212_API_SECRET (per login); optional T212_ENV
 *   ("live" default, or "demo").
 * - Signs: wallet netValue of a fill is the account-currency cash effect (buy
 *   out, sell in). Dividends are cash in. Deposits are cash in, withdrawals out.
 * - History is rate limited, so a sync reads at most 10 pages per feed (500
 *   rows, newest first). If the limit hits first, the rows read so far are kept
 *   and older history is covered by an opening-balance lot at Trading 212's cost.
 * - Repair: 401/403 (key revoked).
 */

const BASES = {
  live: 'https://live.trading212.com/api/v0',
  demo: 'https://demo.trading212.com/api/v0',
} as const;
const MAX_PAGES = 10;

interface T212Instrument {
  ticker: string;
  name?: string;
  isin?: string;
  currency?: string;
}
interface T212Position {
  instrument: T212Instrument;
  quantity: number;
  currentPrice: number;
  averagePricePaid: number;
}
interface T212Order {
  order?: {
    id: number | string;
    side: 'BUY' | 'SELL';
    status: string;
    ticker?: string;
    instrument?: T212Instrument;
    createdAt?: string;
    currency?: string;
  };
  fill?: {
    id?: number | string;
    quantity: number;
    price: number;
    filledAt?: string;
    walletImpact?: { currency?: string; netValue?: number };
  };
}
interface T212Dividend {
  ticker: string;
  reference: string;
  amount: number;
  quantity?: number;
  paidOn: string;
}
interface T212Transaction {
  type: string;
  amount: number;
  currency?: string;
  dateTime: string;
  reference: string;
}
interface T212Page<T> {
  items: T[];
  nextPagePath?: string | null;
}

/** "AAPL_US_EQ" is AAPL, "VUSAl_EQ" (London) is VUSA. */
export function cleanTrading212Ticker(raw: string): string {
  const base = raw.split('_')[0] ?? raw;
  return /[a-z]$/.test(base) ? base.replace(/[a-z]+$/, '') || base : base;
}

/** Trading 212 quotes London shares in pence (GBX). */
function normalise(
  currency: string | undefined,
  value: number,
  fallback: string,
): { currency: string; value: number } {
  const c = (currency ?? fallback).toUpperCase();
  return c === 'GBX' || c === 'GBP0.01'
    ? { currency: 'GBP', value: value / 100 }
    : { currency: c, value };
}

function client(ctx: ConnectorContext): HttpClient {
  const base = optionalSecret(ctx, 'T212_ENV') === 'demo' ? BASES.demo : BASES.live;
  return new HttpClient(ctx, {
    provider: 'Trading 212',
    baseUrl: base,
    headers: {
      Authorization: basicAuth(
        connectionSecret(ctx, 'T212_API_KEY', 'Trading 212'),
        connectionSecret(ctx, 'T212_API_SECRET', 'Trading 212'),
      ),
    },
    retries: 0,
  });
}

async function feed<T>(http: HttpClient, path: string): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = null;
  try {
    for (let i = 0; i < MAX_PAGES; i++) {
      const page: T212Page<T> = next
        ? await http.get<T212Page<T>>(next.replace(/^\/api\/v0/, ''))
        : await http.get<T212Page<T>>(path, { limit: 50 });
      if (!Array.isArray(page?.items)) throw new ProviderDataError('Trading 212', 'history page');
      out.push(...page.items);
      next = page.nextPagePath ?? null;
      if (!next) break;
    }
  } catch (error) {
    if (!(error instanceof ConnectorRateLimitedError)) throw error;
    // Keep what was read; the next sync reads the same newest rows again.
  }
  return out;
}

export async function syncTrading212(
  ctx: ConnectorContext,
  _connection: Connection,
): Promise<SyncResult> {
  void _connection;
  const http = client(ctx);
  const today = todayUtc(ctx.now());
  const result = emptyResult();

  const summary = await http.get<{
    id: number | string;
    currency: string;
    totalValue: number;
    cash?: { availableToTrade?: number };
  }>('/equity/account/summary');
  if (summary?.id === undefined) throw new ProviderDataError('Trading 212', 'summary');
  const accountId = String(summary.id);
  const currency = summary.currency.toUpperCase();
  result.accounts.push(
    providerAccount({
      externalId: accountId,
      name: 'Trading 212 Invest',
      institutionName: 'Trading 212',
      type: 'brokerage',
      subtype: 'taxable',
      currency,
      balance: toMinor(summary.totalValue, currency),
      mask: accountId.slice(-4),
    }),
  );

  const positions = await http.get<T212Position[]>('/equity/positions');
  for (const p of Array.isArray(positions) ? positions : []) {
    const price = normalise(p.instrument.currency, p.currentPrice, currency);
    const avg = normalise(p.instrument.currency, p.averagePricePaid, currency);
    const quantity = toDecimalString(p.quantity);
    if (!quantity || quantity === '0') continue;
    const ticker = cleanTrading212Ticker(p.instrument.ticker);
    result.holdings.push({
      accountExternalId: accountId,
      symbol: ticker,
      name: p.instrument.name ?? ticker,
      securityType: 'equity',
      exchange: /_US_EQ$/.test(p.instrument.ticker) ? 'NASDAQ' : null,
      quantity,
      price: toDecimalString(price.value) ?? '0',
      currency: price.currency,
      costBasis: toMinor(p.quantity * avg.value, avg.currency),
      lots: null,
    } satisfies ProviderHolding);
  }

  const seen = new Set<string>();
  for (const o of await feed<T212Order>(http, '/equity/history/orders')) {
    const order = o.order;
    const fill = o.fill;
    if (!order || !fill || order.status.toUpperCase() !== 'FILLED') continue;
    const id = String(fill.id ?? order.id);
    const date = toLocalDate(fill.filledAt ?? order.createdAt);
    if (!date || seen.has(id)) continue;
    seen.add(id);
    const instrument = order.instrument;
    const ticker = cleanTrading212Ticker(instrument?.ticker ?? order.ticker ?? '');
    const unit = normalise(instrument?.currency ?? order.currency, fill.price, currency);
    const walletCcy = (fill.walletImpact?.currency ?? currency).toUpperCase();
    const cash = Math.abs(
      toMinor(fill.walletImpact?.netValue ?? fill.quantity * unit.value, walletCcy),
    );
    const buy = order.side === 'BUY';
    result.activities.push({
      externalId: `t212_${id}`,
      accountExternalId: accountId,
      symbol: ticker,
      type: buy ? 'buy' : 'sell',
      date,
      quantity: absDecimal(toDecimalString(fill.quantity) ?? '0'),
      price: toDecimalString(unit.value),
      amount: buy ? negate(cash) : cash,
      fees: 0,
      currency: walletCcy,
      splitRatio: null,
    });
  }
  for (const d of await feed<T212Dividend>(http, '/equity/history/dividends')) {
    const date = toLocalDate(d.paidOn);
    if (!date || !d.reference || seen.has(d.reference)) continue;
    seen.add(d.reference);
    result.activities.push({
      externalId: `t212_div_${d.reference}`,
      accountExternalId: accountId,
      symbol: cleanTrading212Ticker(d.ticker),
      type: 'dividend',
      date,
      quantity: null,
      price: null,
      amount: Math.abs(toMinor(d.amount, currency)),
      fees: 0,
      currency,
      splitRatio: null,
    });
  }
  for (const t of await feed<T212Transaction>(http, '/equity/history/transactions')) {
    const date = toLocalDate(t.dateTime);
    const kind = t.type.toUpperCase();
    if (!date || !t.reference || seen.has(`tx_${t.reference}`)) continue;
    seen.add(`tx_${t.reference}`);
    const c = (t.currency ?? currency).toUpperCase();
    const amount = toMinor(t.amount, c);
    const type =
      kind === 'DEPOSIT'
        ? 'contribution'
        : kind === 'WITHDRAW'
          ? 'withdrawal'
          : kind === 'FEE'
            ? 'fee'
            : null;
    if (!type) continue;
    result.activities.push({
      externalId: `t212_tx_${t.reference}`,
      accountExternalId: accountId,
      symbol: null,
      type,
      date,
      quantity: null,
      price: null,
      amount: type === 'contribution' ? Math.abs(amount) : negate(Math.abs(amount)),
      fees: 0,
      currency: c,
      splitRatio: null,
    });
  }
  result.nextCursor = sinceCursor(today);
  return result;
}

export const trading212Adapter = defineAdapter({
  id: 'trading212',
  sync: syncTrading212,
  probe: async (ctx) => {
    await client(ctx).get('/equity/account/summary');
  },
});
