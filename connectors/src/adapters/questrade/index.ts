import type {
  AccountSubtype,
  AccountType,
  Connection,
  ConnectorContext,
  InvestmentActivityType,
  ProviderActivity,
  ProviderHolding,
  SyncResult,
} from '@manaclaude/shared';
import { addDays } from '@manaclaude/shared';
import { HttpClient } from '../../http';
import { readSince, sinceCursor } from '../../util/cursor';
import { todayUtc, toLocalDate, windowStart } from '../../util/dates';
import { absDecimal, toDecimalString, toMinor } from '../../util/decimal';
import {
  connectionSecret,
  defineAdapter,
  emptyResult,
  providerAccount,
  syntheticId,
} from '../../kit';
import { ProviderDataError } from '../../errors';

/**
 * Questrade (Canada), https://www.questrade.com/api/documentation, personal app.
 * Follows Sure: app/models/provider/questrade.rb (refresh-token exchange at
 * login.questrade.com, api_server from the token reply, accounts, balances,
 * positions, activities in windows) and questrade_account/*.
 *
 * - Secrets: QUESTRADE_REFRESH_TOKEN (per login). Questrade rotates it on EVERY
 *   use, so each sync returns the new one in SyncResult.updatedSecrets and the
 *   backend must store it before the next sync or the login is lost.
 * - Accounts: TFSA, RRSP, FHSA and others become brokerage or retirement
 *   accounts in CAD (the combined balance). Positions keep their own currency
 *   (.TO and .VN symbols are CAD, everything else USD).
 * - Activities come in windows of at most 31 days; Questrade gives no activity
 *   id, so an id is built from the row's content and its occurrence.
 * - Repair: invalid_grant at the token exchange, or 401.
 */

export const QUESTRADE_LOGIN = 'https://login.questrade.com/oauth2/token';
const WINDOW_DAYS = 30;
const BACKFILL_DAYS = 365;
const OVERLAP_DAYS = 14;

interface TokenReply {
  access_token: string;
  api_server: string;
  refresh_token: string;
  expires_in?: number;
}
interface QtAccount {
  type: string;
  number: string;
  status?: string;
  clientAccountType?: string;
}
interface QtBalance {
  currency: string;
  cash: number;
  marketValue: number;
  totalEquity: number;
}
interface QtPosition {
  symbol: string;
  openQuantity: number;
  currentPrice: number;
  averageEntryPrice?: number;
  totalCost?: number;
}
interface QtActivity {
  tradeDate?: string;
  transactionDate?: string;
  settlementDate?: string;
  action?: string;
  symbol?: string;
  description?: string;
  currency?: string;
  quantity?: number;
  price?: number;
  grossAmount?: number;
  commission?: number;
  netAmount?: number;
  type?: string;
}

const RETIREMENT = /^(RRSP|LRRSP|SRRSP|RRIF|LIRA|LRIF|PRIF|RIF|LIF|SRIF|DPSP|RDSP|PENSION)/i;

export function mapQuestradeAccount(type: string): { type: AccountType; subtype: AccountSubtype } {
  if (RETIREMENT.test(type)) return { type: 'retirement', subtype: type.toLowerCase() };
  if (/^TFSA/i.test(type)) return { type: 'brokerage', subtype: 'tfsa' };
  if (/^FHSA/i.test(type)) return { type: 'brokerage', subtype: 'fhsa' };
  if (/^RESP/i.test(type)) return { type: 'brokerage', subtype: 'resp' };
  return { type: 'brokerage', subtype: 'taxable' };
}

const currencyOfSymbol = (symbol: string): string =>
  /\.(TO|VN|CN|NE)$/i.test(symbol) ? 'CAD' : 'USD';
const exchangeOfSymbol = (symbol: string): 'TSX' | 'TSXV' | null =>
  /\.TO$/i.test(symbol) ? 'TSX' : /\.VN$/i.test(symbol) ? 'TSXV' : null;

async function exchangeToken(ctx: ConnectorContext): Promise<TokenReply> {
  const refresh = connectionSecret(ctx, 'QUESTRADE_REFRESH_TOKEN', 'Questrade');
  const http = new HttpClient(ctx, {
    provider: 'Questrade',
    baseUrl: QUESTRADE_LOGIN,
    repairStatuses: [401, 403],
    needsRepair: (status, body) =>
      status === 400 && /invalid_grant|Bad Request/i.test(JSON.stringify(body))
        ? 'the login expired'
        : null,
    retries: 0,
  });
  const reply = await http.request<TokenReply>('POST', '', {
    query: { grant_type: 'refresh_token', refresh_token: refresh },
  });
  if (!reply?.access_token || !reply.api_server || !reply.refresh_token)
    throw new ProviderDataError('Questrade', 'token reply');
  return reply;
}

const ACTIONS: Record<string, InvestmentActivityType> = { buy: 'buy', sell: 'sell' };
function activityType(a: QtActivity): InvestmentActivityType | null {
  const type = (a.type ?? '').toLowerCase();
  const action = (a.action ?? '').toLowerCase();
  if (type === 'trades') return ACTIONS[action] ?? null;
  if (type === 'dividends') return 'dividend';
  if (type === 'interest') return 'interest';
  if (type === 'deposits') return 'contribution';
  if (type === 'withdrawals') return 'withdrawal';
  if (type.startsWith('fees')) return 'fee';
  return null;
}

export async function syncQuestrade(
  ctx: ConnectorContext,
  connection: Connection,
): Promise<SyncResult> {
  const token = await exchangeToken(ctx);
  const http = new HttpClient(ctx, {
    provider: 'Questrade',
    baseUrl: `${token.api_server.replace(/\/$/, '')}/v1`,
    headers: { Authorization: `Bearer ${token.access_token}` },
    repairStatuses: [401],
  });
  const today = todayUtc(ctx.now());
  const start = windowStart(today, readSince(connection), {
    backfillDays: BACKFILL_DAYS,
    overlapDays: OVERLAP_DAYS,
  });
  const result = emptyResult();
  result.updatedSecrets = { QUESTRADE_REFRESH_TOKEN: token.refresh_token };

  const accounts = await http.get<{ accounts: QtAccount[] }>('/accounts');
  if (!Array.isArray(accounts?.accounts)) throw new ProviderDataError('Questrade', 'accounts');
  for (const a of accounts.accounts.filter((x) => !x.status || /active/i.test(x.status))) {
    const bal = await http.get<{ combinedBalances: QtBalance[]; perCurrencyBalances: QtBalance[] }>(
      `/accounts/${a.number}/balances`,
    );
    const combined =
      bal.combinedBalances?.find((b) => b.currency === 'CAD') ?? bal.combinedBalances?.[0];
    const currency = (combined?.currency ?? 'CAD').toUpperCase();
    const { type, subtype } = mapQuestradeAccount(a.type);
    result.accounts.push(
      providerAccount({
        externalId: a.number,
        name: `Questrade ${a.type}`,
        institutionName: 'Questrade',
        type,
        subtype,
        currency,
        balance: toMinor(combined?.totalEquity ?? 0, currency),
        mask: a.number.slice(-4),
      }),
    );

    const pos = await http.get<{ positions: QtPosition[] }>(`/accounts/${a.number}/positions`);
    for (const p of pos.positions ?? []) {
      const quantity = toDecimalString(p.openQuantity);
      const c = currencyOfSymbol(p.symbol);
      if (!quantity || quantity === '0') continue;
      result.holdings.push({
        accountExternalId: a.number,
        symbol: p.symbol.replace(/\.(TO|VN)$/i, ''),
        name: p.symbol,
        securityType: 'equity',
        exchange: exchangeOfSymbol(p.symbol),
        quantity,
        price: toDecimalString(p.currentPrice) ?? '0',
        currency: c,
        costBasis: p.totalCost !== undefined ? toMinor(p.totalCost, c) : null,
        lots: null,
      } satisfies ProviderHolding);
    }

    // Activities in windows of at most 31 days, oldest first.
    const occurrences = new Map<string, number>();
    for (let from = start; from <= today; from = addDays(from, WINDOW_DAYS + 1)) {
      const to = addDays(from, WINDOW_DAYS) > today ? today : addDays(from, WINDOW_DAYS);
      const resp = await http.get<{ activities: QtActivity[] }>(
        `/accounts/${a.number}/activities`,
        { startTime: `${from}T00:00:00-05:00`, endTime: `${to}T23:59:59-05:00` },
      );
      for (const act of resp.activities ?? []) {
        const type2 = activityType(act);
        const date = toLocalDate(act.tradeDate ?? act.transactionDate);
        if (!type2 || !date) continue;
        const c = (act.currency ?? currency).toUpperCase();
        const net = toMinor(act.netAmount ?? 0, c);
        const symbol = act.symbol ? act.symbol.replace(/\.(TO|VN)$/i, '') : null;
        const out: ProviderActivity = {
          externalId: syntheticId(
            'qt',
            [
              a.number,
              date,
              act.type ?? '',
              act.action ?? '',
              act.symbol ?? '',
              String(act.quantity ?? ''),
              String(act.price ?? ''),
              String(act.netAmount ?? ''),
            ],
            occurrences,
          ),
          accountExternalId: a.number,
          symbol,
          type: type2,
          date,
          quantity: act.quantity ? absDecimal(toDecimalString(act.quantity) ?? '0') : null,
          price: act.price ? toDecimalString(act.price) : null,
          // netAmount is signed from the account's side (buys negative, includes commission).
          amount: net,
          fees: Math.abs(toMinor(act.commission ?? 0, c)),
          currency: c,
          splitRatio: null,
        };
        result.activities.push(out);
      }
    }
  }
  result.nextCursor = sinceCursor(today);
  return result;
}

export const questradeAdapter = defineAdapter({
  id: 'questrade',
  sync: syncQuestrade,
});
