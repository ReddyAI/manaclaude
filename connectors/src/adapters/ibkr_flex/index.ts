import type {
  Connection,
  ConnectorContext,
  ProviderActivity,
  ProviderHolding,
  ProviderTaxLot,
  SecurityType,
  SyncResult,
} from '@manaclaude/shared';
import { HttpClient, httpRuntime } from '../../http';
import { sinceCursor } from '../../util/cursor';
import { todayUtc, toLocalDate } from '../../util/dates';
import { absDecimal, toDecimalString, toMinor, toMinorOrNull } from '../../util/decimal';
import { findAll, firstText, parseXml, type XmlNode } from '../../util/xml';
import {
  connectionSecret,
  defineAdapter,
  emptyResult,
  providerAccount,
  toExchangeCode,
} from '../../kit';
import {
  ConnectorRateLimitedError,
  ProviderDataError,
  ProviderHttpError,
  repairNeeded,
} from '../../errors';

/**
 * Interactive Brokers Flex Web Service (free, personal token valid up to a
 * year). Follows Sure: app/models/provider/ibkr_flex.rb (SendRequest, then
 * GetStatement with the reference code), ibkr_item/report_parser.rb (sections
 * OpenPositions, Trades, CashTransactions, CashReport, ChangeInPositionValues)
 * and ibkr_account/{holdings,activities,processor}.rb.
 *
 * - Secrets: IBKR_FLEX_TOKEN and IBKR_FLEX_QUERY_ID (per login). The Flex query
 *   must include Open Positions (with Lot detail for tax lots), Trades, Cash
 *   Transactions, Cash Report and Change in Position Value.
 * - One account per FlexStatement, in the account's base currency. Positions
 *   with LevelOfDetail LOT become broker tax lots; SUMMARY rows are the position.
 * - Trades: netCash is already signed (buy out, sell in, commissions included).
 *   Cash transactions: dividends, interest and fees keep their sign.
 * - Repair: Flex error codes 1012 (token expired) and 1015 (invalid token), or
 *   1014 (query invalid for the token). Code 1019 (report not ready) is retried;
 *   1018 (too many requests) is try-later.
 */

export const IBKR_FLEX_API =
  'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService';
const REPAIR_CODES = new Set(['1012', '1015', '1014', '1003']);
const POLL_ATTEMPTS = 6;

const txt = (n: XmlNode, k: string): string | undefined =>
  n.attrs[k] === undefined || n.attrs[k] === '' ? undefined : n.attrs[k];

function typeOf(category: string | undefined, description: string | undefined): SecurityType {
  switch ((category ?? '').toUpperCase()) {
    case 'STK':
      return /\b(ETF|FUND|TRUST)\b/i.test(description ?? '') ? 'etf' : 'equity';
    case 'BOND':
      return 'bond';
    case 'FUND':
      return 'mutual_fund';
    case 'CRYPTO':
      return 'crypto';
    case 'CASH':
      return 'cash';
    default:
      return 'other';
  }
}

function raise(xml: XmlNode): never {
  const code = firstText(xml, 'ErrorCode') ?? '';
  const message = firstText(xml, 'ErrorMessage') ?? 'Flex request failed';
  if (REPAIR_CODES.has(code))
    throw repairNeeded('IBKR Flex', 'the Flex token or query is no longer valid');
  if (code === '1018') throw new ConnectorRateLimitedError('IBKR Flex', null, `${code} ${message}`);
  throw new ProviderHttpError('IBKR Flex', 400, `${code} ${message}`);
}

async function downloadStatement(ctx: ConnectorContext, http: HttpClient): Promise<XmlNode> {
  const token = connectionSecret(ctx, 'IBKR_FLEX_TOKEN', 'IBKR Flex');
  const queryId = connectionSecret(ctx, 'IBKR_FLEX_QUERY_ID', 'IBKR Flex');
  const send = parseXml(
    await http.get<string>('/SendRequest', { t: token, q: queryId, v: 3 }, { text: true }),
  );
  if (firstText(send, 'Status') !== 'Success') raise(send);
  const reference = firstText(send, 'ReferenceCode');
  if (!reference) throw new ProviderDataError('IBKR Flex', 'reference code');
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    const body = await http.get<string>(
      '/GetStatement',
      { t: token, q: reference, v: 3 },
      { text: true },
    );
    const doc = parseXml(body);
    if (doc.name === 'FlexQueryResponse') return doc;
    if (firstText(doc, 'ErrorCode') === '1019') {
      await httpRuntime.sleep(2000 * (attempt + 1)); // statement is still being generated
      continue;
    }
    raise(doc);
  }
  throw new ProviderHttpError('IBKR Flex', 504, 'statement not ready');
}

export function parseFlexStatement(
  statement: XmlNode,
  today: string,
): {
  account: ReturnType<typeof providerAccount>;
  holdings: ProviderHolding[];
  activities: ProviderActivity[];
} {
  const info = findAll(statement, 'AccountInformation')[0];
  const accountId = txt(info ?? statement, 'accountId') ?? txt(statement, 'accountId');
  if (!accountId) throw new ProviderDataError('IBKR Flex', 'account id');
  const currency = (txt(info ?? statement, 'currency') ?? 'USD').toUpperCase();

  // Balance: positions value (base summary) plus ending cash, like Sure; equity summary as a fallback.
  const baseRow = (name: string, field: string): string | undefined => {
    const rows = findAll(statement, name);
    const row =
      rows.find((r) => r.attrs.currency === 'BASE_SUMMARY') ??
      rows.find((r) => r.attrs.currency === currency);
    return row?.attrs[field];
  };
  const positionsValue = baseRow('ChangeInPositionValue', 'endOfPeriodValue');
  const cash = baseRow('CashReportCurrency', 'endingCash') ?? baseRow('CashReport', 'endingCash');
  const equity = findAll(statement, 'EquitySummaryByReportDateInBase')
    .map((r) => [r.attrs.reportDate ?? '', r.attrs.total ?? ''] as const)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .pop()?.[1];
  const balance =
    positionsValue !== undefined || cash !== undefined
      ? toMinor(positionsValue ?? 0, currency) + toMinor(cash ?? 0, currency)
      : toMinor(equity ?? 0, currency);

  const rows = findAll(statement, 'OpenPosition').filter(
    (p) => (p.attrs.assetCategory ?? 'STK') !== 'OPT' && p.attrs.assetCategory !== 'FUT',
  );
  const bySymbol = new Map<string, { summary?: XmlNode; lots: XmlNode[] }>();
  for (const p of rows) {
    const key = `${p.attrs.conid ?? p.attrs.symbol}`;
    const entry = bySymbol.get(key) ?? { lots: [] };
    if ((p.attrs.levelOfDetail ?? 'SUMMARY').toUpperCase() === 'LOT') entry.lots.push(p);
    else entry.summary = p;
    bySymbol.set(key, entry);
  }
  const holdings: ProviderHolding[] = [];
  for (const { summary, lots } of bySymbol.values()) {
    const head = summary ?? (lots[0] as XmlNode);
    const symbol = txt(head, 'symbol');
    if (!symbol) continue;
    const holdingCurrency = (txt(head, 'currency') ?? currency).toUpperCase();
    const quantity = summary
      ? toDecimalString(txt(summary, 'position'))
      : lots.reduce<string | null>(
          (acc, l) => toDecimalString(Number(acc ?? 0) + Number(txt(l, 'position') ?? 0)),
          '0',
        );
    const price = toDecimalString(txt(head, 'markPrice'));
    if (!quantity || quantity === '0' || !price) continue;
    const brokerLots: ProviderTaxLot[] = [];
    for (const l of lots) {
      const acquiredOn = toLocalDate(txt(l, 'openDateTime') ?? txt(l, 'holdingPeriodDateTime'));
      const q = toDecimalString(txt(l, 'position'));
      if (!acquiredOn || !q) continue;
      brokerLots.push({
        externalId: txt(l, 'originatingTransactionID') ?? null,
        acquiredOn,
        quantity: absDecimal(q),
        costBasis: toMinor(txt(l, 'costBasisMoney') ?? 0, holdingCurrency),
        currency: holdingCurrency,
      });
    }
    holdings.push({
      accountExternalId: accountId,
      symbol,
      name: txt(head, 'description') ?? symbol,
      securityType: typeOf(txt(head, 'assetCategory'), txt(head, 'description')),
      exchange: toExchangeCode(txt(head, 'listingExchange')),
      quantity,
      price,
      currency: holdingCurrency,
      costBasis: toMinorOrNull(
        summary
          ? txt(summary, 'costBasisMoney')
          : lots.reduce((n, l) => n + Number(txt(l, 'costBasisMoney') ?? 0), 0),
        holdingCurrency,
      ),
      lots: brokerLots.length > 0 ? brokerLots : null,
    });
  }

  const activities: ProviderActivity[] = [];
  for (const t of findAll(statement, 'Trade')) {
    if ((t.attrs.assetCategory ?? 'STK') === 'OPT' || t.attrs.assetCategory === 'FUT') continue;
    const id = txt(t, 'tradeID') ?? txt(t, 'transactionID');
    const date = toLocalDate(txt(t, 'tradeDate') ?? txt(t, 'dateTime'));
    const side = (txt(t, 'buySell') ?? '').toUpperCase();
    if (!id || !date || (side !== 'BUY' && side !== 'SELL')) continue;
    const c = (txt(t, 'currency') ?? currency).toUpperCase();
    const fee = Math.abs(toMinor(txt(t, 'ibCommission') ?? 0, c));
    activities.push({
      externalId: `ibkr_${id}`,
      accountExternalId: accountId,
      symbol: txt(t, 'symbol') ?? null,
      type: side === 'BUY' ? 'buy' : 'sell',
      date,
      quantity: absDecimal(toDecimalString(txt(t, 'quantity')) ?? '0'),
      price: toDecimalString(txt(t, 'tradePrice')),
      // netCash is signed from the account's side and includes the commission.
      amount:
        txt(t, 'netCash') !== undefined
          ? toMinor(txt(t, 'netCash'), c)
          : (side === 'BUY' ? -1 : 1) * Math.abs(toMinor(txt(t, 'tradeMoney') ?? 0, c)),
      fees: fee,
      currency: c,
      splitRatio: null,
    });
  }
  for (const t of findAll(statement, 'CashTransaction')) {
    const id = txt(t, 'transactionID');
    const date = toLocalDate(txt(t, 'dateTime') ?? txt(t, 'settleDate') ?? txt(t, 'reportDate'));
    if (!id || !date) continue;
    const kind = (txt(t, 'type') ?? '').toLowerCase();
    const c = (txt(t, 'currency') ?? currency).toUpperCase();
    const amount = toMinor(txt(t, 'amount') ?? 0, c);
    let type: ProviderActivity['type'] | null = null;
    if (/dividend/.test(kind)) type = 'dividend';
    else if (/interest/.test(kind)) type = amount >= 0 ? 'interest' : 'fee';
    else if (/withholding|fee|commission/.test(kind)) type = 'fee';
    else if (/deposit|withdrawal/.test(kind)) type = amount >= 0 ? 'contribution' : 'withdrawal';
    if (!type) continue;
    activities.push({
      externalId: `ibkr_cash_${id}`,
      accountExternalId: accountId,
      symbol: txt(t, 'symbol') ?? null,
      type,
      date,
      quantity: null,
      price: null,
      amount,
      fees: 0,
      currency: c,
      splitRatio: null,
    });
  }
  void today;
  return {
    account: providerAccount({
      externalId: accountId,
      name: `Interactive Brokers ${accountId}`,
      institutionName: 'Interactive Brokers',
      type: 'brokerage',
      subtype: 'taxable',
      currency,
      balance,
      mask: accountId.slice(-4),
    }),
    holdings,
    activities,
  };
}

export async function syncIbkrFlex(
  ctx: ConnectorContext,
  _connection: Connection,
): Promise<SyncResult> {
  void _connection;
  const http = new HttpClient(ctx, {
    provider: 'IBKR Flex',
    baseUrl: IBKR_FLEX_API,
    headers: { Accept: 'application/xml' },
    repairStatuses: [401, 403],
  });
  const today = todayUtc(ctx.now());
  const doc = await downloadStatement(ctx, http);
  const statements = findAll(doc, 'FlexStatement');
  if (statements.length === 0) throw new ProviderDataError('IBKR Flex', 'no FlexStatement');
  const result = emptyResult();
  for (const s of statements) {
    const parsed = parseFlexStatement(s, today);
    result.accounts.push(parsed.account);
    result.holdings.push(...parsed.holdings);
    result.activities.push(...parsed.activities);
  }
  result.nextCursor = sinceCursor(today);
  return result;
}

export const ibkrFlexAdapter = defineAdapter({ id: 'ibkr_flex', sync: syncIbkrFlex });
