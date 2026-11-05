import type {
  Connection,
  ConnectorContext,
  ProviderActivity,
  SyncResult,
} from '@manaclaude/shared';
import { HttpClient } from '../../http';
import { hmac, toHex } from '../../util/crypto';
import { sinceCursor } from '../../util/cursor';
import { todayUtc, toLocalDate } from '../../util/dates';
import { negate, toDecimalString, toMinor } from '../../util/decimal';
import {
  connectionSecret,
  defineAdapter,
  emptyResult,
  optionalSecret,
  providerAccount,
} from '../../kit';
import { ProviderDataError } from '../../errors';

/**
 * Binance spot (https://developers.binance.com), read-only API key.
 * Follows Sure: app/models/provider/binance.rb (X-MBX-APIKEY, HMAC-SHA256 hex
 * signature over the query string, account and myTrades) and
 * binance_account/holdings_processor.rb, usd_converter.rb.
 *
 * - Secrets: BINANCE_API_KEY, BINANCE_API_SECRET (per login); optional
 *   BINANCE_BASE_URL (use https://api.binance.us for Binance.US, which is the
 *   only one US residents may use).
 * - One USD crypto account: stablecoins (USDT, USDC, BUSD, USD) count as cash,
 *   other assets are holdings priced from /ticker/price against USDT. Trades
 *   come from myTrades for each held asset's USDT market.
 * - Repair: HTTP 401, or error codes -2014, -2015 (bad key, IP or permission)
 *   and -1022 (bad signature).
 */

export const BINANCE_API = 'https://api.binance.com';
const STABLE = new Set(['USDT', 'USDC', 'BUSD', 'USD', 'FDUSD', 'TUSD']);
const RECV_WINDOW = 5000;

async function signed<T>(
  ctx: ConnectorContext,
  http: HttpClient,
  path: string,
  params: Record<string, string | number> = {},
): Promise<T> {
  const secret = connectionSecret(ctx, 'BINANCE_API_SECRET', 'Binance');
  const query = new URLSearchParams(
    Object.entries({ ...params, timestamp: ctx.now().getTime(), recvWindow: RECV_WINDOW }).map(
      ([k, v]) => [k, String(v)],
    ),
  ).toString();
  const signature = toHex(await hmac('SHA-256', secret, query));
  return http.get<T>(`${path}?${query}&signature=${signature}`);
}

function client(ctx: ConnectorContext): HttpClient {
  return new HttpClient(ctx, {
    provider: 'Binance',
    baseUrl: optionalSecret(ctx, 'BINANCE_BASE_URL') ?? BINANCE_API,
    headers: { 'X-MBX-APIKEY': connectionSecret(ctx, 'BINANCE_API_KEY', 'Binance') },
    needsRepair: (_s, body) => {
      const code = (body as { code?: number } | null)?.code;
      return code === -2014 || code === -2015 || code === -1022 ? 'the API key was rejected' : null;
    },
  });
}

interface BinanceTrade {
  id: number;
  symbol: string;
  price: string;
  qty: string;
  quoteQty: string;
  commission: string;
  commissionAsset: string;
  time: number;
  isBuyer: boolean;
}

export async function syncBinance(
  ctx: ConnectorContext,
  connection: Connection,
): Promise<SyncResult> {
  const http = client(ctx);
  const result = emptyResult();
  const today = todayUtc(ctx.now());
  // One account per login: the connection id keeps a second login of the same exchange from colliding.
  const accountId = `binance_spot_${connection.id}`;

  const account = await signed<{ balances: { asset: string; free: string; locked: string }[] }>(
    ctx,
    http,
    '/api/v3/account',
  );
  if (!Array.isArray(account?.balances)) throw new ProviderDataError('Binance', 'account');
  const prices = new Map(
    (await http.get<{ symbol: string; price: string }[]>('/api/v3/ticker/price')).map((t) => [
      t.symbol,
      t.price,
    ]),
  );

  let cash = 0;
  let value = 0;
  const markets: string[] = [];
  for (const b of account.balances) {
    const qty = toDecimalString(Number(b.free) + Number(b.locked));
    if (!qty || qty === '0') continue;
    if (STABLE.has(b.asset)) {
      cash += toMinor(qty, 'USD');
      continue;
    }
    const price = prices.get(`${b.asset}USDT`);
    if (!price) continue;
    markets.push(`${b.asset}USDT`);
    result.holdings.push({
      accountExternalId: accountId,
      symbol: b.asset,
      name: b.asset,
      securityType: 'crypto',
      exchange: 'CRYPTO',
      quantity: qty,
      price: toDecimalString(price) ?? '0',
      currency: 'USD',
      costBasis: null,
      lots: null,
    });
    value += toMinor(Number(qty) * Number(price), 'USD');
  }
  result.accounts.push(
    providerAccount({
      externalId: accountId,
      name: 'Binance',
      institutionName: 'Binance',
      type: 'crypto',
      currency: 'USD',
      balance: value + cash,
    }),
  );

  for (const symbol of markets) {
    const trades = await signed<BinanceTrade[]>(ctx, http, '/api/v3/myTrades', {
      symbol,
      limit: 1000,
    });
    for (const t of Array.isArray(trades) ? trades : []) {
      const date = toLocalDate(t.time);
      if (!date) continue;
      // Commission is charged in the bought asset or in BNB; count it only when it is the quote (USDT).
      const fee = t.commissionAsset === 'USDT' ? toMinor(t.commission, 'USD') : 0;
      const gross = toMinor(t.quoteQty, 'USD');
      const act: ProviderActivity = {
        externalId: `bn_${t.symbol}_${t.id}`,
        accountExternalId: accountId,
        symbol: symbol.replace(/USDT$/, ''),
        type: t.isBuyer ? 'buy' : 'sell',
        date,
        quantity: toDecimalString(t.qty),
        price: toDecimalString(t.price),
        amount: t.isBuyer ? negate(gross + fee) : gross - fee,
        fees: fee,
        currency: 'USD',
        splitRatio: null,
      };
      result.activities.push(act);
    }
  }
  result.nextCursor = sinceCursor(today);
  return result;
}

export const binanceAdapter = defineAdapter({
  id: 'binance',
  sync: syncBinance,
  probe: async (ctx) => {
    await signed(ctx, client(ctx), '/api/v3/account');
  },
});
