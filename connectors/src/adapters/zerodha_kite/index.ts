import type {
  Connection,
  ConnectorContext,
  ProviderActivity,
  SyncResult,
} from '@manaclaude/shared';
import { HttpClient } from '../../http';
import { sha256, toHex } from '../../util/crypto';
import { sinceCursor } from '../../util/cursor';
import { todayUtc, toLocalDate } from '../../util/dates';
import { toDecimalString, toMinor, negate } from '../../util/decimal';
import {
  appSecret,
  connectionSecret,
  defineAdapter,
  emptyResult,
  providerAccount,
  toExchangeCode,
} from '../../kit';
import { ProviderDataError } from '../../errors';

/**
 * Zerodha Kite Connect Personal (https://kite.trade/docs/connect/v3), free for
 * your own account (no market data or history, which is all we need).
 * Zerodha is also reachable through SnapTrade; this is the free backup.
 *
 * - Secrets: KITE_API_KEY, KITE_API_SECRET (Worker secrets, from the Kite
 *   developer console); KITE_ACCESS_TOKEN (per login).
 * - The access token dies every morning (around 6 am IST). That is Zerodha's
 *   rule, not an error: the connection goes to needs_repair and the repair is
 *   one Kite login, which hands back a request_token. exchangeKiteRequestToken()
 *   turns it into the next access token (checksum = SHA-256 of
 *   api_key + request_token + api_secret).
 * - Holdings: quantity includes t1_quantity (bought, not yet settled); cost
 *   basis = quantity x average_price, in INR. Kite gives no purchase dates, so
 *   the shared sync records the position as one opening lot.
 * - Activity: /trades only returns today's fills. Each fill has a trade_id, so a
 *   daily sync builds the history without duplicates.
 * - Repair: HTTP 403 (TokenException) or 401.
 */

export const KITE_API = 'https://api.kite.trade';

interface KiteEnvelope<T> {
  status: 'success' | 'error';
  data: T;
  message?: string;
  error_type?: string;
}

interface KiteHolding {
  tradingsymbol: string;
  exchange: string;
  isin?: string;
  quantity: number;
  t1_quantity?: number;
  average_price: number;
  last_price: number;
}

interface KiteTrade {
  trade_id: string;
  order_id: string;
  exchange: string;
  tradingsymbol: string;
  transaction_type: 'BUY' | 'SELL';
  quantity: number;
  average_price: number;
  fill_timestamp?: string;
  exchange_timestamp?: string;
}

function client(ctx: ConnectorContext): HttpClient {
  const apiKey = appSecret(ctx, 'KITE_API_KEY', 'Zerodha Kite');
  const token = connectionSecret(ctx, 'KITE_ACCESS_TOKEN', 'Zerodha Kite');
  return new HttpClient(ctx, {
    provider: 'Zerodha Kite',
    baseUrl: KITE_API,
    headers: { 'X-Kite-Version': '3', Authorization: `token ${apiKey}:${token}` },
    needsRepair: (_status, body) =>
      (body as { error_type?: string } | null)?.error_type === 'TokenException'
        ? 'the daily Kite login expired'
        : null,
  });
}

function data<T>(envelope: KiteEnvelope<T>, what: string): T {
  if (!envelope || envelope.status !== 'success') throw new ProviderDataError('Zerodha Kite', what);
  return envelope.data;
}

/** Second half of the Kite login: request_token to access_token. The backend stores the result as KITE_ACCESS_TOKEN. */
export async function exchangeKiteRequestToken(
  ctx: ConnectorContext,
  requestToken: string,
): Promise<string> {
  const apiKey = appSecret(ctx, 'KITE_API_KEY', 'Zerodha Kite');
  const apiSecret = appSecret(ctx, 'KITE_API_SECRET', 'Zerodha Kite');
  const checksum = toHex(await sha256(apiKey + requestToken + apiSecret));
  const http = new HttpClient(ctx, {
    provider: 'Zerodha Kite',
    baseUrl: KITE_API,
    headers: { 'X-Kite-Version': '3' },
  });
  const resp = await http.request<KiteEnvelope<{ access_token: string }>>(
    'POST',
    '/session/token',
    {
      form: { api_key: apiKey, request_token: requestToken, checksum },
    },
  );
  return data(resp, 'session').access_token;
}

export async function syncKite(
  ctx: ConnectorContext,
  _connection: Connection,
): Promise<SyncResult> {
  void _connection;
  const http = client(ctx);
  const result = emptyResult();
  const today = todayUtc(ctx.now());

  const profile = data(
    await http.get<KiteEnvelope<{ user_id: string; user_name?: string }>>('/user/profile'),
    'profile',
  );
  const holdings = data(
    await http.get<KiteEnvelope<KiteHolding[]>>('/portfolio/holdings'),
    'holdings',
  );
  const margins = data(
    await http.get<
      KiteEnvelope<{ equity?: { available?: { cash?: number; live_balance?: number } } }>
    >('/user/margins'),
    'margins',
  );
  const accountId = `kite_${profile.user_id}`;

  let positionsValue = 0;
  for (const h of holdings) {
    const quantity = toDecimalString((h.quantity ?? 0) + (h.t1_quantity ?? 0));
    const price = toDecimalString(h.last_price);
    if (!quantity || quantity === '0' || !price) continue;
    result.holdings.push({
      accountExternalId: accountId,
      symbol: h.tradingsymbol,
      name: h.tradingsymbol,
      securityType: /BEES$|ETF$/.test(h.tradingsymbol) ? 'etf' : 'equity',
      exchange: toExchangeCode(h.exchange),
      quantity,
      price,
      currency: 'INR',
      costBasis: toMinor(Number(quantity) * h.average_price, 'INR'),
      lots: null,
    });
    positionsValue += toMinor(Number(quantity) * h.last_price, 'INR');
  }
  const cash = toMinor(margins.equity?.available?.cash ?? 0, 'INR');
  result.accounts.push(
    providerAccount({
      externalId: accountId,
      name: 'Zerodha Demat',
      institutionName: 'Zerodha',
      type: 'brokerage',
      subtype: 'demat',
      currency: 'INR',
      balance: positionsValue + cash,
      mask: profile.user_id.slice(-4),
    }),
  );

  // Today's fills only; trade_id keeps repeated syncs from adding them twice.
  const trades = data(await http.get<KiteEnvelope<KiteTrade[]>>('/trades'), 'trades');
  for (const t of trades) {
    const date = toLocalDate(t.fill_timestamp ?? t.exchange_timestamp) ?? today;
    const value = toMinor(t.quantity * t.average_price, 'INR');
    const act: ProviderActivity = {
      externalId: t.trade_id,
      accountExternalId: accountId,
      symbol: t.tradingsymbol,
      type: t.transaction_type === 'BUY' ? 'buy' : 'sell',
      date,
      quantity: toDecimalString(t.quantity),
      price: toDecimalString(t.average_price),
      amount: t.transaction_type === 'BUY' ? negate(value) : value,
      fees: 0,
      currency: 'INR',
      splitRatio: null,
    };
    result.activities.push(act);
  }
  result.nextCursor = sinceCursor(today);
  return result;
}

export const zerodhaKiteAdapter = defineAdapter({
  id: 'zerodha_kite',
  sync: syncKite,
  probe: async (ctx) => {
    await client(ctx).get('/user/profile');
  },
});
