import type {
  Connection,
  ConnectorContext,
  InvestmentActivityType,
  ProviderActivity,
  ProviderHolding,
  SecurityType,
  SyncResult,
} from '@manaclaude/shared';
import { HttpClient } from '../../http';
import { hmac, toBase64 } from '../../util/crypto';
import { readSince, sinceCursor } from '../../util/cursor';
import { absDecimal, negate, toDecimalString, toMinor } from '../../util/decimal';
import { todayUtc, toLocalDate, windowStart } from '../../util/dates';
import {
  appSecret,
  connectionSecret,
  defineAdapter,
  emptyResult,
  providerAccount,
  toExchangeCode,
} from '../../kit';
import { ProviderDataError, repairNeeded } from '../../errors';

/**
 * SnapTrade Personal (https://docs.snaptrade.com), free for 20 connections.
 * Covers Robinhood, E*TRADE, Zerodha and others. Follows Sure:
 * app/models/provider/snaptrade.rb (endpoints, option/future/cfd filter),
 * snaptrade_account/holdings_processor.rb, activities_processor.rb
 * (ACTIVITY_RULES) and data_helpers.rb.
 *
 * Sure talks to SnapTrade's OAuth beta (Bearer token, no user secret). This
 * adapter uses the documented key-and-signature API that Personal keys get:
 * clientId and timestamp go in the query, and a `Signature` header carries
 * base64(HMAC-SHA256(consumerKey, {"content","path","query"} as sorted JSON)).
 *
 * - Secrets: SNAPTRADE_CLIENT_ID, SNAPTRADE_CONSUMER_KEY (Worker secrets);
 *   SNAPTRADE_USER_ID, SNAPTRADE_USER_SECRET (the one SnapTrade user created for
 *   this app) and SNAPTRADE_AUTHORIZATION_ID (the brokerage connection this
 *   Connection covers; one slot each).
 * - Lots: SnapTrade's tax lots are a paid add-on, so positions go out with
 *   lots: null and planInvestmentSync derives them with deriveLotsFifo from the
 *   BUY/SELL activities (an opening-balance lot covers history the broker no
 *   longer returns).
 * - Signs: cash amounts are normalised by activity type (buy out, sell and
 *   dividend in), so a broker that signs them the other way does not matter.
 * - Repair: a disabled brokerage authorization (the login expired), or 401/403.
 */

export const SNAPTRADE_API = 'https://api.snaptrade.com';
const API_PREFIX = '/api/v1';
const FIRST_SYNC_FROM = '2000-01-01';
const OVERLAP_DAYS = 30;
const PAGE = 1000;

type Obj = Record<string, unknown>;

interface StAccount {
  id: string;
  brokerage_authorization: string;
  name?: string | null;
  number?: string | null;
  institution_name?: string | null;
  meta?: { type?: string | null; status?: string | null } | null;
  raw_type?: string | null;
  balance?: { total?: { amount: number | string | null; currency: string } | null } | null;
}

interface StBalance {
  currency: { code: string };
  cash: number | string | null;
  buying_power?: number | string | null;
}

interface StPosition {
  symbol: {
    symbol: {
      symbol: string;
      raw_symbol?: string | null;
      description?: string | null;
      currency?: { code: string } | null;
      exchange?: { code?: string | null; mic_code?: string | null } | null;
      type?: { code?: string | null; description?: string | null } | null;
    };
  };
  units: number | string | null;
  fractional_units?: number | string | null;
  price: number | string | null;
  average_purchase_price?: number | string | null;
  currency?: { code: string } | null;
}

interface StActivity {
  id: string;
  symbol?: { symbol?: string | null; raw_symbol?: string | null } | null;
  option_symbol?: unknown;
  price?: number | string | null;
  units?: number | string | null;
  amount?: number | string | null;
  currency?: { code: string } | null;
  type: string;
  trade_date?: string | null;
  settlement_date?: string | null;
  fee?: number | string | null;
}

export async function snaptradeSignature(
  consumerKey: string,
  path: string,
  query: string,
  body: string | undefined,
): Promise<string> {
  // The SDK signs sorted-key JSON: content, path, query.
  const content = body === undefined ? 'null' : JSON.stringify(sortKeys(JSON.parse(body)));
  const payload = `{"content":${content},"path":${JSON.stringify(path)},"query":${JSON.stringify(query)}}`;
  return toBase64(await hmac('SHA-256', consumerKey, payload));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Obj)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

/** Signed GET against SnapTrade with the user's id and secret on the query. */
class SnapTrade {
  private readonly http: HttpClient;
  constructor(private readonly ctx: ConnectorContext) {
    appSecret(ctx, 'SNAPTRADE_CLIENT_ID', 'SnapTrade');
    const consumerKey = appSecret(ctx, 'SNAPTRADE_CONSUMER_KEY', 'SnapTrade');
    this.http = new HttpClient(ctx, {
      provider: 'SnapTrade',
      baseUrl: SNAPTRADE_API,
      // The signature covers the exact query string that is sent.
      sign: async ({ path, query, body }) => ({
        Signature: await snaptradeSignature(consumerKey, path, query, body),
      }),
    });
  }

  get<T>(path: string, extra: Record<string, string | number | undefined> = {}): Promise<T> {
    const userId = connectionSecret(this.ctx, 'SNAPTRADE_USER_ID', 'SnapTrade');
    const userSecret = connectionSecret(this.ctx, 'SNAPTRADE_USER_SECRET', 'SnapTrade');
    const params: Record<string, string | number | undefined> = {
      ...extra,
      clientId: this.ctx.secrets.SNAPTRADE_CLIENT_ID,
      timestamp: Math.floor(this.ctx.now().getTime() / 1000),
      userId,
      userSecret,
    };
    // Sorted keys so the signed string equals the sent string.
    const sorted = Object.fromEntries(Object.entries(params).sort(([a], [b]) => (a < b ? -1 : 1)));
    return this.http.get<T>(`${API_PREFIX}${path}`, sorted);
  }
}

const TYPE_MAP: Record<string, SecurityType> = {
  cs: 'equity',
  ad: 'equity',
  et: 'etf',
  oef: 'mutual_fund',
  cef: 'mutual_fund',
  bnd: 'bond',
  crypto: 'crypto',
  wi: 'other',
  rt: 'other',
  ps: 'equity',
  ut: 'other',
  struct: 'other',
};

const ACTIVITY_TYPES: Record<
  string,
  { type: InvestmentActivityType; cash: 'in' | 'out' | 'trade' | 'none' }
> = {
  BUY: { type: 'buy', cash: 'out' },
  SELL: { type: 'sell', cash: 'in' },
  REI: { type: 'reinvest', cash: 'out' },
  REINVEST: { type: 'reinvest', cash: 'out' },
  DIVIDEND: { type: 'dividend', cash: 'in' },
  DIV: { type: 'dividend', cash: 'in' },
  DISTRIBUTION: { type: 'dividend', cash: 'in' },
  RETURN_OF_CAPITAL: { type: 'dividend', cash: 'in' },
  SUBSTITUTE_DIVIDEND: { type: 'dividend', cash: 'in' },
  INTEREST: { type: 'interest', cash: 'in' },
  CONTRIBUTION: { type: 'contribution', cash: 'in' },
  CASH: { type: 'contribution', cash: 'in' },
  WITHDRAWAL: { type: 'withdrawal', cash: 'out' },
  FEE: { type: 'fee', cash: 'out' },
  TAX: { type: 'fee', cash: 'out' },
  TRANSFER_IN: { type: 'contribution', cash: 'in' },
  INTERNAL_CASH_TRANSFER_IN: { type: 'contribution', cash: 'in' },
  TRANSFER_OUT: { type: 'withdrawal', cash: 'out' },
  INTERNAL_CASH_TRANSFER_OUT: { type: 'withdrawal', cash: 'out' },
  EXTERNAL_ASSET_TRANSFER_IN: { type: 'transfer_in', cash: 'none' },
  INTERNAL_ASSET_TRANSFER_IN: { type: 'transfer_in', cash: 'none' },
  EXTERNAL_ASSET_TRANSFER_OUT: { type: 'transfer_out', cash: 'none' },
  INTERNAL_ASSET_TRANSFER_OUT: { type: 'transfer_out', cash: 'none' },
  SPLIT: { type: 'split', cash: 'none' },
  REVERSE_SPLIT: { type: 'split', cash: 'none' },
  SPLIT_REVERSE: { type: 'split', cash: 'none' },
  STOCK_DIVIDEND: { type: 'reinvest', cash: 'none' },
};

export function mapSnaptradeActivity(
  a: StActivity,
  accountExternalId: string,
  fallbackCurrency: string,
): ProviderActivity | null {
  const rule = ACTIVITY_TYPES[a.type.toUpperCase()];
  const date = toLocalDate(a.trade_date ?? a.settlement_date);
  if (!rule || !date || a.option_symbol) return null;
  const currency = (a.currency?.code ?? fallbackCurrency).toUpperCase();
  const raw = toMinor(a.amount ?? 0, currency);
  const magnitude = Math.abs(raw);
  const amount = rule.cash === 'none' ? 0 : rule.cash === 'in' ? magnitude : negate(magnitude);
  const units = toDecimalString(a.units);
  const price = toDecimalString(a.price);
  return {
    externalId: a.id,
    accountExternalId,
    symbol: a.symbol?.raw_symbol ?? a.symbol?.symbol ?? null,
    type: rule.type,
    date,
    quantity: units && units !== '0' ? absDecimal(units) : null,
    price: price && price !== '0' ? price : null,
    amount,
    fees: Math.abs(toMinor(a.fee ?? 0, currency)),
    currency,
    splitRatio: null,
  };
}

export function mapSnaptradePosition(
  p: StPosition,
  accountExternalId: string,
  fallbackCurrency: string,
): ProviderHolding | null {
  const sym = p.symbol?.symbol;
  if (!sym?.symbol) return null;
  // fractional_units holds the full position (with fractions) when the broker fills it in.
  const fractional = toDecimalString(p.fractional_units);
  const quantity = fractional && fractional !== '0' ? fractional : toDecimalString(p.units);
  const price = toDecimalString(p.price);
  if (!quantity || !price || quantity === '0') return null;
  const currency = (p.currency?.code ?? sym.currency?.code ?? fallbackCurrency).toUpperCase();
  const avg = toDecimalString(p.average_purchase_price);
  return {
    accountExternalId,
    symbol: sym.raw_symbol ?? sym.symbol,
    name: sym.description ?? sym.symbol,
    securityType: TYPE_MAP[(sym.type?.code ?? '').toLowerCase()] ?? 'equity',
    exchange: toExchangeCode(sym.exchange?.mic_code ?? sym.exchange?.code),
    quantity,
    price,
    currency,
    // Total cost = units x average purchase price, when the broker reports it.
    costBasis: avg && avg !== '0' ? toMinor(Number(quantity) * Number(avg), currency) : null,
    lots: null,
  };
}

export async function syncSnapTrade(
  ctx: ConnectorContext,
  connection: Connection,
): Promise<SyncResult> {
  const st = new SnapTrade(ctx);
  const authorizationId = connectionSecret(ctx, 'SNAPTRADE_AUTHORIZATION_ID', 'SnapTrade');
  const today = todayUtc(ctx.now());
  const since = readSince(connection);
  const result = emptyResult();

  // A disabled authorization means the broker login expired: the user repairs it.
  const auths = await st.get<Obj[]>('/authorizations');
  if (!Array.isArray(auths)) throw new ProviderDataError('SnapTrade', 'authorizations');
  const mine = auths.find((x) => x.id === authorizationId);
  if (!mine) throw repairNeeded('SnapTrade', 'the brokerage connection no longer exists');
  if (mine.disabled === true)
    throw repairNeeded('SnapTrade', 'the brokerage connection is disabled');

  const accounts = await st.get<StAccount[]>('/accounts');
  if (!Array.isArray(accounts)) throw new ProviderDataError('SnapTrade', 'accounts');

  for (const a of accounts.filter((x) => x.brokerage_authorization === authorizationId)) {
    const currency = (a.balance?.total?.currency ?? 'USD').toUpperCase();
    const balances = await st.get<StBalance[]>(`/accounts/${a.id}/balances`);
    const positionsRaw = await st.get<StPosition[]>(`/accounts/${a.id}/positions`);
    const holdings = (Array.isArray(positionsRaw) ? positionsRaw : [])
      .map((p) => mapSnaptradePosition(p, a.id, currency))
      .filter((h): h is ProviderHolding => h !== null);

    const cash = (Array.isArray(balances) ? balances : [])
      .filter((b) => (b.currency?.code ?? currency).toUpperCase() === currency)
      .reduce((n, b) => n + toMinor(b.cash ?? 0, currency), 0);
    const positionsValue = holdings
      .filter((h) => h.currency === currency)
      .reduce((n, h) => n + toMinor(Number(h.quantity) * Number(h.price), currency), 0);
    const total =
      a.balance?.total?.amount != null
        ? toMinor(a.balance.total.amount, currency)
        : cash + positionsValue;

    const kind = (a.meta?.type ?? a.raw_type ?? '').toLowerCase();
    const retirement = /ira|401|rrsp|tfsa|retire|roth/.test(kind);
    result.accounts.push(
      providerAccount({
        externalId: a.id,
        name: a.name ?? a.institution_name ?? 'Brokerage account',
        institutionName: a.institution_name ?? null,
        type: retirement ? 'retirement' : 'brokerage',
        subtype: /roth/.test(kind)
          ? 'roth_ira'
          : /ira/.test(kind)
            ? 'ira'
            : /401/.test(kind)
              ? '401k'
              : 'taxable',
        currency,
        balance: total,
        mask: a.number ? a.number.slice(-4) : null,
      }),
    );
    result.holdings.push(...holdings);

    // Activities, paged by offset.
    const start = windowStart(today, since, { backfillDays: 0, overlapDays: OVERLAP_DAYS });
    const startDate = since ? start : FIRST_SYNC_FROM;
    for (let offset = 0; offset < 1_000_000;) {
      const page = await st.get<
        { data: StActivity[]; pagination?: { total?: number } } | StActivity[]
      >(`/accounts/${a.id}/activities`, { startDate, endDate: today, offset, limit: PAGE });
      const rows = Array.isArray(page) ? page : (page?.data ?? []);
      for (const row of rows) {
        const act = mapSnaptradeActivity(row, a.id, currency);
        if (act) result.activities.push(act);
      }
      offset += rows.length;
      const total = Array.isArray(page) ? undefined : page?.pagination?.total;
      if (rows.length === 0 || (total !== undefined && offset >= total)) break;
    }
  }
  result.nextCursor = sinceCursor(today);
  return result;
}

export const snaptradeAdapter = defineAdapter({
  id: 'snaptrade',
  sync: syncSnapTrade,
  probe: async (ctx) => {
    const id = connectionSecret(ctx, 'SNAPTRADE_AUTHORIZATION_ID', 'SnapTrade');
    const auths = await new SnapTrade(ctx).get<Obj[]>('/authorizations');
    const mine = Array.isArray(auths) ? auths.find((x) => x.id === id) : undefined;
    if (!mine || mine.disabled === true)
      throw repairNeeded('SnapTrade', 'the brokerage connection is disabled');
  },
});
