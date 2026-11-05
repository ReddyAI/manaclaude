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
import { connectionSecret, defineAdapter, emptyResult, providerAccount } from '../../kit';
import { ProviderDataError } from '../../errors';

/**
 * WazirX (https://docs.wazirx.com), personal read-only API key. India, INR.
 * Not in Sure; written from WazirX's REST docs.
 *
 * - Secrets: WAZIRX_API_KEY, WAZIRX_API_SECRET (per login).
 * - Signing: signed endpoints take `timestamp` and `recvWindow` in the query and
 *   `signature` = hex HMAC-SHA256(secret, query string), plus header X-Api-Key.
 * - One INR crypto account per connection: free INR is cash, every other asset
 *   with a balance is a holding priced from the public ticker list (<asset>inr,
 *   or <asset>usdt converted at usdtinr).
 * - Trades come from /myTrades per traded market; buys are cash out, sells cash in.
 * - Repair: 401, 403, or error code 2112 (invalid API key) / signature errors.
 */

export const WAZIRX_API = 'https://api.wazirx.com/sapi/v1';
const RECV_WINDOW = 10_000;

interface WxFund {
  asset: string;
  free: string;
  locked: string;
}
interface WxTicker {
  symbol: string;
  lastPrice: string;
}
interface WxTrade {
  id: number | string;
  symbol: string;
  price: string;
  qty: string;
  quoteQty: string;
  time: number;
  isBuyer: boolean;
}

function client(ctx: ConnectorContext): HttpClient {
  const key = connectionSecret(ctx, 'WAZIRX_API_KEY', 'WazirX');
  return new HttpClient(ctx, {
    provider: 'WazirX',
    baseUrl: WAZIRX_API,
    headers: { 'X-Api-Key': key },
    needsRepair: (_status, body) => {
      const code = (body as { code?: number } | null)?.code;
      return code === 2112 || code === 2113 ? 'the API key was rejected' : null;
    },
  });
}

async function signedGet<T>(
  ctx: ConnectorContext,
  http: HttpClient,
  path: string,
  params: Record<string, string | number> = {},
): Promise<T> {
  const secret = connectionSecret(ctx, 'WAZIRX_API_SECRET', 'WazirX');
  const query = new URLSearchParams(
    Object.entries({ ...params, recvWindow: RECV_WINDOW, timestamp: ctx.now().getTime() }).map(
      ([k, v]) => [k, String(v)],
    ),
  ).toString();
  const signature = toHex(await hmac('SHA-256', secret, query));
  return http.get<T>(`${path}?${query}&signature=${signature}`);
}

export async function syncWazirX(
  ctx: ConnectorContext,
  connection: Connection,
): Promise<SyncResult> {
  const http = client(ctx);
  const result = emptyResult();
  const today = todayUtc(ctx.now());
  // One account per login: the connection id keeps a second login of the same exchange from colliding.
  const accountId = `wazirx_main_${connection.id}`;

  const funds = await signedGet<WxFund[]>(ctx, http, '/funds');
  if (!Array.isArray(funds)) throw new ProviderDataError('WazirX', 'funds');
  const tickers = await http.get<WxTicker[]>('/tickers/24hr');
  const last = new Map(
    (Array.isArray(tickers) ? tickers : []).map((t) => [t.symbol.toLowerCase(), t.lastPrice]),
  );
  const usdtInr = Number(last.get('usdtinr') ?? 0);

  let cash = 0;
  let value = 0;
  const markets: string[] = [];
  for (const f of funds) {
    const asset = f.asset.toLowerCase();
    const qty = toDecimalString(Number(f.free) + Number(f.locked));
    if (!qty || qty === '0') continue;
    if (asset === 'inr') {
      cash += toMinor(qty, 'INR');
      continue;
    }
    let price = last.get(`${asset}inr`);
    if (!price && usdtInr > 0 && last.get(`${asset}usdt`)) {
      price = toDecimalString(Number(last.get(`${asset}usdt`)) * usdtInr) ?? undefined;
    }
    if (!price) continue;
    markets.push(last.has(`${asset}inr`) ? `${asset}inr` : `${asset}usdt`);
    result.holdings.push({
      accountExternalId: accountId,
      symbol: asset.toUpperCase(),
      name: asset.toUpperCase(),
      securityType: 'crypto',
      exchange: 'CRYPTO',
      quantity: qty,
      price: toDecimalString(price) ?? '0',
      currency: 'INR',
      costBasis: null,
      lots: null,
    });
    value += toMinor(Number(qty) * Number(price), 'INR');
  }
  result.accounts.push(
    providerAccount({
      externalId: accountId,
      name: 'WazirX',
      institutionName: 'WazirX',
      type: 'crypto',
      currency: 'INR',
      balance: value + cash,
    }),
  );

  for (const symbol of markets) {
    const trades = await signedGet<WxTrade[]>(ctx, http, '/myTrades', { symbol, limit: 1000 });
    if (!Array.isArray(trades)) continue;
    const quote = symbol.endsWith('usdt') ? 'USDT' : 'INR';
    for (const t of trades) {
      const date = toLocalDate(t.time);
      if (!date) continue;
      // Value in INR: quoteQty is in the quote asset; convert USDT trades at today's rate.
      const quoteValue = Number(t.quoteQty) * (quote === 'USDT' ? usdtInr : 1);
      const amount = toMinor(quoteValue, 'INR');
      const act: ProviderActivity = {
        externalId: `wx_${t.id}`,
        accountExternalId: accountId,
        symbol: symbol.replace(/(inr|usdt)$/, '').toUpperCase(),
        type: t.isBuyer ? 'buy' : 'sell',
        date,
        quantity: toDecimalString(t.qty),
        price: toDecimalString(Number(t.price) * (quote === 'USDT' ? usdtInr : 1)),
        amount: t.isBuyer ? negate(amount) : amount,
        fees: 0,
        currency: 'INR',
        splitRatio: null,
      };
      result.activities.push(act);
    }
  }
  result.nextCursor = sinceCursor(today);
  return result;
}

export const wazirxAdapter = defineAdapter({
  id: 'wazirx',
  sync: syncWazirX,
  probe: async (ctx) => {
    await signedGet(ctx, client(ctx), '/funds');
  },
});
