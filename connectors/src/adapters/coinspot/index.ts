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
  providerAccount,
  syntheticId,
} from '../../kit';
import { ProviderDataError, repairNeeded } from '../../errors';

/**
 * CoinSpot (Australia), https://www.coinspot.com.au/v2/api, read-only key.
 * Follows Sure: app/models/provider/coinspot.rb (POST JSON body with a nonce,
 * `key` and `sign` = HMAC-SHA512 hex of the exact body, read-only /api/v2/ro
 * routes) and coinspot_account/* (balances with an AUD rate, completed orders).
 *
 * - Secrets: COINSPOT_API_KEY, COINSPOT_API_SECRET (per login).
 * - One AUD crypto account: AUD is cash, each coin with a balance is a holding
 *   priced at the AUD rate CoinSpot returns. Completed buy and sell orders become
 *   activities (buy cash out, sell cash in).
 * - Repair: 401/403 or a body with status "error" mentioning the key or signature.
 */

export const COINSPOT_API = 'https://www.coinspot.com.au';

async function post<T>(
  ctx: ConnectorContext,
  http: HttpClient,
  path: string,
  extra: Record<string, unknown> = {},
): Promise<T> {
  const secret = connectionSecret(ctx, 'COINSPOT_API_SECRET', 'CoinSpot');
  const body = JSON.stringify({ nonce: ctx.now().getTime(), ...extra });
  const sign = toHex(await hmac('SHA-512', secret, body));
  const reply = await http.request<{ status?: string; message?: string } & T>('POST', path, {
    body,
    headers: { 'Content-Type': 'application/json', sign },
  });
  if (!reply || typeof reply !== 'object') throw new ProviderDataError('CoinSpot', 'reply');
  if (reply.status && reply.status !== 'ok') {
    if (/key|sign|auth|permission|nonce/i.test(reply.message ?? '')) {
      throw repairNeeded('CoinSpot', 'the API key was rejected');
    }
    throw new ProviderDataError('CoinSpot', 'status');
  }
  return reply;
}

interface CsOrder {
  id?: string;
  coin: string;
  market?: string;
  amount: number | string;
  rate: number | string;
  audtotal?: number | string;
  total?: number | string;
  audfeeExGst?: number | string;
  audGst?: number | string;
  solddate?: string;
  created?: string;
  type?: string;
  otype?: string;
}

export async function syncCoinSpot(
  ctx: ConnectorContext,
  _connection: Connection,
): Promise<SyncResult> {
  void _connection;
  const http = new HttpClient(ctx, {
    provider: 'CoinSpot',
    baseUrl: COINSPOT_API,
    headers: { key: connectionSecret(ctx, 'COINSPOT_API_KEY', 'CoinSpot') },
  });
  const result = emptyResult();
  const today = todayUtc(ctx.now());
  const accountId = 'coinspot_main';

  const bal = await post<{
    balances: Record<string, { balance: number; audbalance: number; rate: number }>[];
  }>(ctx, http, '/api/v2/ro/my/balances');
  if (!Array.isArray(bal.balances)) throw new ProviderDataError('CoinSpot', 'balances');
  let cash = 0;
  let value = 0;
  for (const entry of bal.balances) {
    for (const [coin, d] of Object.entries(entry)) {
      const qty = toDecimalString(d.balance);
      if (!qty || qty === '0') continue;
      if (coin === 'AUD') {
        cash += toMinor(qty, 'AUD');
        continue;
      }
      result.holdings.push({
        accountExternalId: accountId,
        symbol: coin,
        name: coin,
        securityType: 'crypto',
        exchange: 'CRYPTO',
        quantity: qty,
        price: toDecimalString(d.rate) ?? '0',
        currency: 'AUD',
        costBasis: null,
        lots: null,
      });
      value += toMinor(d.audbalance ?? Number(qty) * Number(d.rate), 'AUD');
    }
  }
  result.accounts.push(
    providerAccount({
      externalId: accountId,
      name: 'CoinSpot',
      institutionName: 'CoinSpot',
      type: 'crypto',
      currency: 'AUD',
      balance: value + cash,
    }),
  );

  const orders = await post<{ buyorders?: CsOrder[]; sellorders?: CsOrder[]; orders?: CsOrder[] }>(
    ctx,
    http,
    '/api/v2/ro/my/orders/completed',
  );
  const rows: [CsOrder, 'buy' | 'sell'][] = [
    ...(orders.buyorders ?? []).map((o) => [o, 'buy'] as [CsOrder, 'buy']),
    ...(orders.sellorders ?? []).map((o) => [o, 'sell'] as [CsOrder, 'sell']),
    ...(orders.orders ?? []).map(
      (o) =>
        [o, /sell/i.test(o.type ?? o.otype ?? '') ? 'sell' : 'buy'] as [CsOrder, 'buy' | 'sell'],
    ),
  ];
  const seenIds = new Set<string>();
  const occurrences = new Map<string, number>();
  for (const [o, side] of rows) {
    const date = toLocalDate(o.solddate ?? o.created);
    if (!date) continue;
    // A real id repeated in the list is one order; orders without an id are told apart by occurrence.
    if (o.id) {
      if (seenIds.has(o.id)) continue;
      seenIds.add(o.id);
    }
    const id =
      o.id ??
      syntheticId(
        'o',
        [side, o.coin, o.solddate ?? o.created ?? '', String(o.amount), String(o.rate)],
        occurrences,
      );
    const total = toMinor(o.audtotal ?? o.total ?? Number(o.amount) * Number(o.rate), 'AUD');
    const fee = toMinor(Number(o.audfeeExGst ?? 0) + Number(o.audGst ?? 0), 'AUD');
    const act: ProviderActivity = {
      externalId: `cs_${id}`,
      accountExternalId: accountId,
      symbol: o.coin,
      type: side,
      date,
      quantity: toDecimalString(o.amount),
      price: toDecimalString(o.rate),
      amount: side === 'buy' ? negate(total + fee) : total - fee,
      fees: fee,
      currency: 'AUD',
      splitRatio: null,
    };
    result.activities.push(act);
  }
  result.nextCursor = sinceCursor(today);
  return result;
}

export const coinspotAdapter = defineAdapter({
  id: 'coinspot',
  sync: syncCoinSpot,
  probe: async (ctx) => {
    const http = new HttpClient(ctx, {
      provider: 'CoinSpot',
      baseUrl: COINSPOT_API,
      headers: { key: connectionSecret(ctx, 'COINSPOT_API_KEY', 'CoinSpot') },
    });
    await post(ctx, http, '/api/v2/ro/status');
  },
});
