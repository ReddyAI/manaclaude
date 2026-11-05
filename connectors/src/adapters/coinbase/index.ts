import type {
  Connection,
  ConnectorContext,
  InvestmentActivityType,
  ProviderActivity,
  ProviderHolding,
  SyncResult,
} from '@manaclaude/shared';
import { HttpClient } from '../../http';
import { randomHex, signJwt } from '../../util/crypto';
import { absDecimal, negate, toDecimalString, toMinor } from '../../util/decimal';
import { sinceCursor } from '../../util/cursor';
import { todayUtc, toLocalDate } from '../../util/dates';
import { connectionSecret, defineAdapter, emptyResult, providerAccount } from '../../kit';
import { ProviderDataError, ProviderHttpError } from '../../errors';

/**
 * Coinbase (v2 API, Coinbase Developer Platform keys).
 * Follows Sure: app/models/provider/coinbase.rb (JWT auth for EC and Ed25519
 * keys, paginated accounts, buys, sells, spot price), coinbase_account/
 * processor.rb (native-currency balance, activity labels such as
 * staking_reward and interest) and holdings_processor.rb.
 *
 * - Secrets: COINBASE_API_KEY (the key name) and COINBASE_API_SECRET (PEM EC
 *   key, or the base64 Ed25519 secret), both per login; read-only scopes are enough.
 * - One crypto account per connection (named Coinbase, in the user's native
 *   currency), with one holding per coin wallet that has a balance. Sure keeps one
 *   account per wallet; one account is easier to read next to a bank list.
 * - Signs: buys are cash out (total including the fee), sells are cash in
 *   (net of the fee); staking rewards and interest are income.
 * - Lots: Coinbase gives no cost basis on holdings, so lots are derived from the
 *   buy and sell history by the shared sync.
 * - Repair: 401 or 403 (revoked or expired key).
 */

export const COINBASE_API = 'https://api.coinbase.com';
const TRANSFER_TYPES = new Set([
  'send',
  'pro_deposit',
  'exchange_deposit',
  'staking_transfer',
  'unstaking_transfer',
  'vault_withdrawal',
  'pro_withdrawal',
  'exchange_withdrawal',
]);
const SKIP_TRANSACTION_TYPES = new Set([
  'buy',
  'sell',
  'trade',
  'advanced_trade_fill',
  'fiat_deposit',
  'fiat_withdrawal',
  'request',
]);

interface CbMoney {
  amount: string;
  currency: string;
}

interface CbWallet {
  id: string;
  name?: string;
  type?: string;
  currency: { code: string; name?: string; type?: string } | string;
  balance: CbMoney;
}

interface CbPage<T> {
  data: T[];
  pagination?: { next_uri?: string | null };
}

interface CbOrder {
  id: string;
  status?: string;
  created_at: string;
  amount: CbMoney;
  total: CbMoney;
  fee?: CbMoney;
  committed?: boolean;
}

interface CbTransaction {
  id: string;
  type: string;
  status?: string;
  amount: CbMoney;
  native_amount: CbMoney;
  created_at: string;
  description?: string | null;
}

function client(ctx: ConnectorContext): HttpClient {
  const key = connectionSecret(ctx, 'COINBASE_API_KEY', 'Coinbase');
  const secret = connectionSecret(ctx, 'COINBASE_API_SECRET', 'Coinbase');
  return new HttpClient(ctx, {
    provider: 'Coinbase',
    baseUrl: COINBASE_API,
    headers: { 'CB-VERSION': '2024-10-01' },
    sign: async ({ method, path }) => {
      const now = Math.floor(ctx.now().getTime() / 1000);
      const jwt = await signJwt(
        secret,
        { kid: key, nonce: randomHex(16) },
        {
          sub: key,
          iss: 'cdp',
          nbf: now,
          exp: now + 120,
          uri: `${method} api.coinbase.com${path.split('?')[0]}`,
        },
      );
      return { Authorization: `Bearer ${jwt}` };
    },
  });
}

async function listAll<T>(http: HttpClient, path: string): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = `${path}${path.includes('?') ? '&' : '?'}limit=100`;
  for (let i = 0; i < 200 && next; i++) {
    const page: CbPage<T> = await http.get<CbPage<T>>(next);
    if (!Array.isArray(page?.data)) throw new ProviderDataError('Coinbase', 'list');
    out.push(...page.data);
    next = page.pagination?.next_uri ?? null;
  }
  return out;
}

const codeOf = (w: CbWallet): string =>
  (typeof w.currency === 'string' ? w.currency : w.currency.code).toUpperCase();
const nameOf = (w: CbWallet): string =>
  typeof w.currency === 'string' ? codeOf(w) : (w.currency.name ?? codeOf(w));
const isFiat = (w: CbWallet): boolean =>
  w.type === 'fiat' || (typeof w.currency !== 'string' && w.currency.type === 'fiat');

export function mapCoinbaseOrder(
  o: CbOrder,
  kind: 'buy' | 'sell',
  accountId: string,
  symbol: string,
): ProviderActivity | null {
  const date = toLocalDate(o.created_at);
  if (!date || o.status === 'canceled' || o.committed === false) return null;
  const currency = o.total.currency.toUpperCase();
  const total = Math.abs(toMinor(o.total.amount, currency));
  const quantity = absDecimal(toDecimalString(o.amount.amount) ?? '0');
  const unit =
    Number(quantity) > 0 ? toDecimalString(Number(o.total.amount) / Number(quantity)) : null;
  return {
    externalId: o.id,
    accountExternalId: accountId,
    symbol,
    type: kind,
    date,
    quantity,
    price: unit,
    amount: kind === 'buy' ? negate(total) : total,
    fees: Math.abs(toMinor(o.fee?.amount ?? 0, o.fee?.currency ?? currency)),
    currency,
    splitRatio: null,
  };
}

/**
 * Ledger rows other than buys and sells. A reward is two activities: the income
 * (dividend or interest, for the totals) and the units received at their market
 * value on the day (a transfer in with a price, so the lot has a cost basis).
 * A plain send or receive moves units with no cash effect; units received are
 * costed at the day's market value too, because Coinbase cannot know the
 * original cost of coins that came from elsewhere.
 */
export function mapCoinbaseTransaction(
  t: CbTransaction,
  accountId: string,
  symbol: string,
): ProviderActivity[] {
  const type = t.type.toLowerCase();
  if (SKIP_TRANSACTION_TYPES.has(type) || (t.status && t.status !== 'completed')) return [];
  const date = toLocalDate(t.created_at);
  if (!date) return [];
  const currency = t.native_amount.currency.toUpperCase();
  const qty = toDecimalString(t.amount.amount);
  if (!qty || qty === '0') return [];
  const incoming = !qty.startsWith('-');
  const units = absDecimal(qty);
  const value = Math.abs(toMinor(t.native_amount.amount, currency));
  const unitPrice =
    Number(units) > 0
      ? toDecimalString(Math.abs(Number(t.native_amount.amount)) / Number(units))
      : null;
  const base = { accountExternalId: accountId, symbol, date, currency, fees: 0, splitRatio: null };

  if (type === 'staking_reward' || type === 'inflation_reward' || type === 'interest') {
    const income: InvestmentActivityType = type === 'interest' ? 'interest' : 'dividend';
    return [
      { ...base, externalId: t.id, type: income, quantity: null, price: null, amount: value },
      {
        ...base,
        externalId: `${t.id}_units`,
        type: 'transfer_in',
        quantity: units,
        price: unitPrice,
        amount: 0,
      },
    ];
  }
  if (TRANSFER_TYPES.has(type)) {
    return [
      {
        ...base,
        externalId: t.id,
        type: incoming ? 'transfer_in' : 'transfer_out',
        quantity: units,
        price: incoming ? unitPrice : null,
        amount: 0,
      },
    ];
  }
  return [];
}

export async function syncCoinbase(
  ctx: ConnectorContext,
  _connection: Connection,
): Promise<SyncResult> {
  void _connection;
  const http = client(ctx);
  const result = emptyResult();
  const today = todayUtc(ctx.now());

  const user = await http.get<{ data: { id: string; native_currency?: string } }>('/v2/user');
  const native = (user?.data?.native_currency ?? 'USD').toUpperCase();
  const accountId = `coinbase_${user?.data?.id ?? 'main'}`;
  const wallets = await listAll<CbWallet>(http, '/v2/accounts');

  let cash = 0;
  const holdings: ProviderHolding[] = [];
  for (const w of wallets) {
    const qty = toDecimalString(w.balance.amount);
    if (!qty || qty === '0') continue;
    if (isFiat(w)) {
      if (codeOf(w) === native) cash += toMinor(qty, native);
      continue;
    }
    const symbol = codeOf(w);
    const spot = await http.get<{ data: { amount: string } }>(
      `/v2/prices/${symbol}-${native}/spot`,
    );
    const price = toDecimalString(spot?.data?.amount) ?? '0';
    holdings.push({
      accountExternalId: accountId,
      symbol,
      name: nameOf(w),
      securityType: 'crypto',
      exchange: 'CRYPTO',
      quantity: qty,
      price,
      currency: native,
      costBasis: null,
      lots: null,
    });
  }
  const value = holdings.reduce(
    (n, h) => n + toMinor(Number(h.quantity) * Number(h.price), native),
    0,
  );
  result.accounts.push(
    providerAccount({
      externalId: accountId,
      name: 'Coinbase',
      institutionName: 'Coinbase',
      type: 'crypto',
      currency: native,
      balance: value + cash,
    }),
  );
  result.holdings = holdings;

  // History for lots: buys and sells with their fees, plus rewards and transfers from the ledger.
  for (const w of wallets.filter((x) => !isFiat(x))) {
    const symbol = codeOf(w);
    for (const kind of ['buy', 'sell'] as const) {
      const orders = await listAll<CbOrder>(http, `/v2/accounts/${w.id}/${kind}s`);
      for (const o of orders) {
        const act = mapCoinbaseOrder(o, kind, accountId, symbol);
        if (act) result.activities.push(act);
      }
    }
    const txs = await listAll<CbTransaction>(http, `/v2/accounts/${w.id}/transactions`);
    for (const t of txs) {
      result.activities.push(...mapCoinbaseTransaction(t, accountId, symbol));
    }
  }
  result.nextCursor = sinceCursor(today);
  return result;
}

export const coinbaseAdapter = defineAdapter({
  id: 'coinbase',
  sync: syncCoinbase,
  probe: async (ctx) => {
    try {
      await client(ctx).get('/v2/user');
    } catch (error) {
      if (error instanceof ProviderHttpError && error.status === 404) return;
      throw error;
    }
  },
});
