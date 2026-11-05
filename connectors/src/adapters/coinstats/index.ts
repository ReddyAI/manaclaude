import type {
  Connection,
  ConnectorContext,
  ProviderActivity,
  SyncResult,
} from '@manaclaude/shared';
import { HttpClient } from '../../http';
import { sinceCursor } from '../../util/cursor';
import { todayUtc, toLocalDate } from '../../util/dates';
import { absDecimal, negate, toDecimalString, toMinor } from '../../util/decimal';
import {
  connectionSecret,
  defineAdapter,
  emptyResult,
  optionalSecret,
  providerAccount,
} from '../../kit';
import { ProviderDataError } from '../../errors';

/**
 * CoinStats (https://coinstats.app/api-docs), exchanges and DeFi in one portfolio.
 * Follows Sure: app/models/provider/coinstats.rb (X-API-KEY, portfolio/coins and
 * portfolio/transactions, paged) and coinstats_account/holdings_processor.rb.
 * Check the free plan's limits at sign-up (README).
 *
 * - Secrets: COINSTATS_API_KEY and COINSTATS_PORTFOLIO_ID (per login: the
 *   portfolio CoinStats built from the exchange or wallet); optional
 *   COINSTATS_CURRENCY (USD default) and COINSTATS_PAGE_SIZE (100).
 * - One crypto account per portfolio. Coins are holdings priced at CoinStats'
 *   price; fiat entries (isFiat) are cash. Buys and sells are activities (buy
 *   cash out, sell cash in), deposits and withdrawals move units with no cash.
 * - Repair: 401/403 (key revoked).
 */

export const COINSTATS_API = 'https://openapiv1.coinstats.app';
const DEFAULT_LIMIT = 100;

interface CsCoinRow {
  count: number | string;
  coin?: { id?: string; symbol?: string; name?: string; price?: number | string; isFiat?: boolean };
  price?: number | string;
  totalWorth?: number | string;
  isFiat?: boolean;
}
interface CsTx {
  id?: string;
  hash?: string;
  type?: string;
  transactionType?: string;
  date: string;
  coinData?: { count?: number | string; symbol?: string; currentValue?: number | string };
  fee?: { count?: number | string; coin?: { symbol?: string } } | number | string | null;
  profitLoss?: unknown;
}

const arrayOf = <T>(resp: unknown): T[] => {
  if (Array.isArray(resp)) return resp as T[];
  const r = resp as { result?: unknown; data?: unknown } | null;
  if (Array.isArray(r?.result)) return r.result as T[];
  if (Array.isArray(r?.data)) return r.data as T[];
  throw new ProviderDataError('CoinStats', 'list');
};

async function pages<T>(
  http: HttpClient,
  path: string,
  query: Record<string, string>,
  limit: number,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 200; page++) {
    const rows = arrayOf<T>(await http.get(path, { ...query, page, limit }));
    out.push(...rows);
    if (rows.length < limit) break;
  }
  return out;
}

export async function syncCoinStats(
  ctx: ConnectorContext,
  _connection: Connection,
): Promise<SyncResult> {
  void _connection;
  const http = new HttpClient(ctx, {
    provider: 'CoinStats',
    baseUrl: COINSTATS_API,
    headers: { 'X-API-KEY': connectionSecret(ctx, 'COINSTATS_API_KEY', 'CoinStats') },
  });
  const portfolioId = connectionSecret(ctx, 'COINSTATS_PORTFOLIO_ID', 'CoinStats');
  const currency = (optionalSecret(ctx, 'COINSTATS_CURRENCY') ?? 'USD').toUpperCase();
  const today = todayUtc(ctx.now());
  const accountId = `coinstats_${portfolioId}`;
  const limit = Number(optionalSecret(ctx, 'COINSTATS_PAGE_SIZE')) || DEFAULT_LIMIT;
  const result = emptyResult();

  const coins = await pages<CsCoinRow>(http, '/portfolio/coins', { portfolioId }, limit);
  let cash = 0;
  let value = 0;
  for (const row of coins) {
    const symbol = row.coin?.symbol?.toUpperCase();
    const qty = toDecimalString(row.count);
    if (!symbol || !qty || qty === '0') continue;
    const price = toDecimalString(row.coin?.price ?? row.price);
    const fiat = row.coin?.isFiat === true || row.isFiat === true;
    if (fiat && symbol === currency) {
      cash += toMinor(qty, currency);
      continue;
    }
    if (!price) continue;
    result.holdings.push({
      accountExternalId: accountId,
      symbol,
      name: row.coin?.name ?? symbol,
      securityType: 'crypto',
      exchange: 'CRYPTO',
      quantity: qty,
      price,
      currency,
      costBasis: null,
      lots: null,
    });
    value +=
      row.totalWorth !== undefined
        ? toMinor(row.totalWorth, currency)
        : toMinor(Number(qty) * Number(price), currency);
  }
  result.accounts.push(
    providerAccount({
      externalId: accountId,
      name: 'CoinStats portfolio',
      institutionName: 'CoinStats',
      type: 'crypto',
      currency,
      balance: value + cash,
    }),
  );

  const txs = await pages<CsTx>(http, '/portfolio/transactions', { portfolioId, currency }, limit);
  const seen = new Set<string>();
  for (const t of txs) {
    const id = t.id ?? t.hash;
    const date = toLocalDate(t.date);
    const kind = (t.type ?? t.transactionType ?? '').toLowerCase();
    const symbol = t.coinData?.symbol?.toUpperCase();
    const units = toDecimalString(t.coinData?.count);
    if (!id || !date || !symbol || !units || seen.has(id)) continue;
    seen.add(id);
    const worth = Math.abs(toMinor(t.coinData?.currentValue ?? 0, currency));
    let type: ProviderActivity['type'];
    let amount = 0;
    if (/^buy|^receive_buy/.test(kind)) {
      type = 'buy';
      amount = negate(worth);
    } else if (/^sell/.test(kind)) {
      type = 'sell';
      amount = worth;
    } else if (/deposit|receive|transfer_in|income|reward|airdrop/.test(kind)) {
      type = 'transfer_in';
    } else if (/withdraw|send|transfer_out/.test(kind)) {
      type = 'transfer_out';
    } else continue;
    const q = absDecimal(units);
    result.activities.push({
      externalId: `cstats_${id}`,
      accountExternalId: accountId,
      symbol,
      type,
      date,
      quantity: q,
      price:
        type === 'transfer_out' || Number(q) === 0
          ? null
          : toDecimalString(Math.abs(Number(t.coinData?.currentValue ?? 0)) / Number(q)),
      amount,
      fees: 0,
      currency,
      splitRatio: null,
    });
  }
  result.nextCursor = sinceCursor(today);
  return result;
}

export const coinstatsAdapter = defineAdapter({
  id: 'coinstats',
  sync: syncCoinStats,
  probe: async (ctx) => {
    await new HttpClient(ctx, {
      provider: 'CoinStats',
      baseUrl: COINSTATS_API,
      headers: { 'X-API-KEY': connectionSecret(ctx, 'COINSTATS_API_KEY', 'CoinStats') },
    }).get('/wallet/blockchains');
  },
});
