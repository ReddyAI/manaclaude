import type {
  Connection,
  ConnectorContext,
  ProviderActivity,
  ProviderHolding,
  SyncResult,
} from '@manaclaude/shared';
import { HttpClient } from '../../http';
import { concatBytes, fromBase64, hmac, sha256, toBase64, utf8 } from '../../util/crypto';
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
import {
  ConnectorRateLimitedError,
  ProviderDataError,
  ProviderHttpError,
  repairNeeded,
} from '../../errors';

/**
 * Kraken (https://docs.kraken.com/api), read-only API key.
 * Follows Sure: app/models/provider/kraken.rb (nonce plus
 * API-Sign = base64(HMAC-SHA512(base64 secret, path + SHA256(nonce + body)))),
 * kraken_account/asset_normalizer.rb (XXBT is BTC, ZUSD is USD, staking
 * suffixes are dropped), holdings_processor.rb and ledger_processor.rb.
 *
 * - Secrets: KRAKEN_API_KEY and KRAKEN_API_SECRET (per login); optional
 *   KRAKEN_QUOTE (USD default) for the currency the account is valued in.
 * - One crypto account in the quote currency: fiat balance is cash, other assets
 *   are holdings priced from the public Ticker. Trades come from TradesHistory
 *   (buy: cash out including the fee, sell: cash in net of the fee); staking and
 *   reward ledger lines become income plus units received.
 * - Kraken answers 200 with an "error" list, so errors are read from the body:
 *   invalid key, signature or permission means repair; a rate-limit error is
 *   try-later.
 */

export const KRAKEN_API = 'https://api.kraken.com';
const FIAT = new Set(['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'JPY']);
const ALIASES: Record<string, string> = { XBT: 'BTC', XDG: 'DOGE' };

export function normalizeKrakenAsset(raw: string): string {
  let a = raw.replace(/\.(S|M|B|F|P)$/i, '').replace(/\d+\.\w$/, '');
  if (/^[XZ][A-Z]{3}$/.test(a)) a = a.slice(1);
  a = ALIASES[a] ?? a;
  return a === 'ZUSD' ? 'USD' : a;
}

interface KrakenReply<T> {
  error: string[];
  result: T;
}

function classify(errors: string[]): Error {
  const text = errors.join('; ');
  if (/Invalid key|Invalid signature|Permission denied|Invalid nonce/i.test(text)) {
    return /nonce/i.test(text)
      ? new ProviderHttpError('Kraken', 400, text)
      : repairNeeded('Kraken', 'the API key was rejected');
  }
  if (/rate limit|Throttled|Too many/i.test(text))
    return new ConnectorRateLimitedError('Kraken', null, text);
  return new ProviderHttpError('Kraken', 400, text);
}

async function priv<T>(
  ctx: ConnectorContext,
  http: HttpClient,
  path: string,
  params: Record<string, string | number> = {},
): Promise<T> {
  const secret = connectionSecret(ctx, 'KRAKEN_API_SECRET', 'Kraken');
  const nonce = String(ctx.now().getTime() * 1000 + Math.floor(Math.random() * 1000));
  const body = new URLSearchParams({
    nonce,
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  }).toString();
  const digest = await sha256(nonce + body);
  const sig = toBase64(await hmac('SHA-512', fromBase64(secret), concatBytes(utf8(path), digest)));
  const reply = await http.request<KrakenReply<T>>('POST', path, {
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'API-Sign': sig },
  });
  if (!reply || !Array.isArray(reply.error)) throw new ProviderDataError('Kraken', 'reply');
  if (reply.error.length > 0) throw classify(reply.error);
  return reply.result;
}

interface LedgerRow {
  refid: string;
  time: number;
  type: string;
  asset: string;
  amount: string;
  fee: string;
}
interface TradeRow {
  pair: string;
  time: number;
  type: 'buy' | 'sell';
  price: string;
  cost: string;
  fee: string;
  vol: string;
}

export async function syncKraken(
  ctx: ConnectorContext,
  _connection: Connection,
): Promise<SyncResult> {
  void _connection;
  const key = connectionSecret(ctx, 'KRAKEN_API_KEY', 'Kraken');
  const quote = (optionalSecret(ctx, 'KRAKEN_QUOTE') ?? 'USD').toUpperCase();
  const http = new HttpClient(ctx, {
    provider: 'Kraken',
    baseUrl: KRAKEN_API,
    headers: { 'API-Key': key },
    repairStatuses: [401, 403],
  });
  const result = emptyResult();
  const today = todayUtc(ctx.now());
  const accountId = 'kraken_main';

  const balances = await priv<Record<string, { balance: string; hold_trade?: string }>>(
    ctx,
    http,
    '/0/private/BalanceEx',
  );
  const totals = new Map<string, string>();
  for (const [raw, b] of Object.entries(balances)) {
    const asset = normalizeKrakenAsset(raw);
    const qty = toDecimalString(Number(b.balance));
    if (!qty || qty === '0') continue;
    totals.set(asset, toDecimalString(Number(totals.get(asset) ?? 0) + Number(qty)) ?? qty);
  }
  let cash = 0;
  let value = 0;
  const priced: string[] = [];
  const coins = [...totals.keys()].filter((a) => !FIAT.has(a));
  for (const a of totals.keys()) if (a === quote) cash += toMinor(totals.get(a), quote);
  if (coins.length > 0) {
    const pairs = coins.map((c) => `${c === 'BTC' ? 'XBT' : c}${quote}`).join(',');
    const ticker = await http.get<KrakenReply<Record<string, { c: [string, string] }>>>(
      '/0/public/Ticker',
      { pair: pairs },
    );
    const prices = new Map<string, string>();
    for (const [pair, t] of Object.entries(ticker?.result ?? {})) {
      for (const c of coins) {
        const base = c === 'BTC' ? 'XBT' : c;
        if (
          pair === `${base}${quote}` ||
          pair === `X${base}Z${quote}` ||
          pair === `${base}Z${quote}`
        )
          prices.set(c, t.c[0]);
      }
    }
    for (const c of coins) {
      const price = prices.get(c);
      const qty = totals.get(c) as string;
      if (!price) continue;
      priced.push(c);
      result.holdings.push({
        accountExternalId: accountId,
        symbol: c,
        name: c,
        securityType: 'crypto',
        exchange: 'CRYPTO',
        quantity: qty,
        price: toDecimalString(price) ?? '0',
        currency: quote,
        costBasis: null,
        lots: null,
      } satisfies ProviderHolding);
      value += toMinor(Number(qty) * Number(price), quote);
    }
  }
  result.accounts.push(
    providerAccount({
      externalId: accountId,
      name: 'Kraken',
      institutionName: 'Kraken',
      type: 'crypto',
      currency: quote,
      balance: value + cash,
    }),
  );

  // Trades, 50 per page by offset.
  const seen = new Set<string>();
  for (let ofs = 0; ofs < 100_000;) {
    const page = await priv<{ trades: Record<string, TradeRow>; count: number }>(
      ctx,
      http,
      '/0/private/TradesHistory',
      { ofs },
    );
    const entries = Object.entries(page.trades ?? {});
    for (const [txid, t] of entries) {
      if (seen.has(txid)) continue;
      seen.add(txid);
      const date = toLocalDate(Math.floor(t.time));
      const m = /^(?:X|Z)?([A-Z0-9]{2,5}?)(?:Z)?(USD|EUR|GBP|CAD|AUD)$/.exec(t.pair);
      const base = m ? normalizeKrakenAsset(m[1] as string) : null;
      const q = m ? (m[2] as string) : quote;
      if (!date || !base) continue;
      const cost = toMinor(Number(t.cost) + (t.type === 'buy' ? Number(t.fee) : -Number(t.fee)), q);
      const act: ProviderActivity = {
        externalId: txid,
        accountExternalId: accountId,
        symbol: base,
        type: t.type,
        date,
        quantity: toDecimalString(Number(t.vol)),
        price: toDecimalString(Number(t.price)),
        amount: t.type === 'buy' ? negate(cost) : cost,
        fees: toMinor(t.fee, q),
        currency: q,
        splitRatio: null,
      };
      result.activities.push(act);
    }
    ofs += entries.length;
    if (entries.length === 0 || ofs >= page.count) break;
  }

  // Ledger lines that are not trades: staking rewards and transfers.
  const ledger = await priv<{ ledger: Record<string, LedgerRow>; count: number }>(
    ctx,
    http,
    '/0/private/Ledgers',
  );
  for (const [id, l] of Object.entries(ledger.ledger ?? {})) {
    const date = toLocalDate(Math.floor(l.time));
    const asset = normalizeKrakenAsset(l.asset);
    if (
      !date ||
      FIAT.has(asset) ||
      !['staking', 'earn', 'deposit', 'withdrawal', 'transfer'].includes(l.type)
    )
      continue;
    if (l.type === 'transfer' && /\.(S|M|B|F|P)$/i.test(l.asset)) continue; // staking wrapper moves are not new coins
    const amount = Number(l.amount);
    const reward = l.type === 'staking' || l.type === 'earn';
    result.activities.push({
      externalId: `ledger_${id}`,
      accountExternalId: accountId,
      symbol: asset,
      type: reward ? 'transfer_in' : amount >= 0 ? 'transfer_in' : 'transfer_out',
      date,
      quantity: toDecimalString(Math.abs(amount)),
      price: null,
      amount: 0,
      fees: 0,
      currency: quote,
      splitRatio: null,
    });
  }
  void priced;
  result.nextCursor = sinceCursor(today);
  return result;
}

export const krakenAdapter = defineAdapter({
  id: 'kraken',
  sync: syncKraken,
  probe: async (ctx) => {
    const http = new HttpClient(ctx, {
      provider: 'Kraken',
      baseUrl: KRAKEN_API,
      headers: { 'API-Key': connectionSecret(ctx, 'KRAKEN_API_KEY', 'Kraken') },
    });
    await priv(ctx, http, '/0/private/BalanceEx');
  },
});
