import type {
  AccountSubtype,
  AccountType,
  Connection,
  ConnectorContext,
  InvestmentActivityType,
  ProviderAccount,
  ProviderActivity,
  ProviderHolding,
  ProviderTaxLot,
  SecurityType,
  SyncResult,
} from '@manaclaude/shared';
import { HttpClient } from '../../http';
import { encodeCursor, parseCursor } from '../../util/cursor';
import { todayUtc, toLocalDate, windowStart } from '../../util/dates';
import { absDecimal, negate, toDecimalString, toMinor, toMinorOrNull } from '../../util/decimal';
import {
  appSecret,
  connectionSecret,
  defineAdapter,
  emptyResult,
  optionalSecret,
  providerAccount,
  providerTransaction,
  toExchangeCode,
} from '../../kit';
import { ProviderDataError, ProviderHttpError, ConnectorRepairNeededError } from '../../errors';

/**
 * Plaid (Transactions, Liabilities, Investments), https://plaid.com/docs/api.
 * Follows Sure: app/models/provider/plaid.rb, plaid_item/importer.rb (the
 * transactions/sync loop), plaid_account/processor.rb and type_mappable.rb
 * (account types), plaid_account/investments/* (holdings, trades, cash
 * security handling), plaid_account/liabilities/* (APR, mortgage, student).
 *
 * - Secrets: PLAID_CLIENT_ID, PLAID_SECRET (Worker secrets), PLAID_ENV
 *   ("sandbox" or "production", default production), PLAID_ACCESS_TOKEN (per login).
 * - Signs: Plaid reports money OUT as positive, so amounts are negated. Card and
 *   loan balances.current is what is owed (positive), the model's rule already.
 *   Investment activity cash amounts are negated too (a buy is cash out).
 * - Pending: a posted row carries pending_transaction_id, which becomes
 *   pendingExternalId; removed ids go to removedTransactionExternalIds.
 * - Cursor: {cursor: <transactions/sync cursor>, invSince: <date>}. The result is
 *   deltaOnly, because transactions/sync only lists what changed.
 * - Lots: Plaid Investments holdings include tax_lots when the institution gives
 *   them; when absent, the shared sync derives lots from the activities.
 *   (Plaid's public docs describe holdings, securities and investment
 *   transactions; the tax_lots shape here is read tolerantly, see README.)
 * - Repair: ITEM_LOGIN_REQUIRED and the other item errors below. The repair
 *   flow opens Plaid Link in update mode: use createPlaidUpdateLinkToken().
 */

const HOSTS = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
} as const;
const REPAIR_CODES = new Set([
  'ITEM_LOGIN_REQUIRED',
  'ITEM_LOCKED',
  'ITEM_NOT_FOUND',
  'INVALID_ACCESS_TOKEN',
  'INVALID_CREDENTIALS',
  'USER_PERMISSION_REVOKED',
  'ACCESS_NOT_GRANTED',
  'NO_ACCOUNTS',
  'ITEM_NO_LONGER_AVAILABLE',
]);
/** Error codes that only mean "this Plaid product is not enabled for this login". */
const SKIP_PRODUCT_CODES = new Set([
  'PRODUCTS_NOT_SUPPORTED',
  'PRODUCT_NOT_READY',
  'ADDITIONAL_CONSENT_REQUIRED',
  'NO_INVESTMENT_ACCOUNTS',
  'NO_LIABILITY_ACCOUNTS',
  'INVALID_PRODUCT',
]);
const BACKFILL_DAYS = 730;
const OVERLAP_DAYS = 30;

interface PlaidError {
  error_type?: string;
  error_code?: string;
  error_message?: string;
}

interface PlaidBalances {
  available: number | null;
  current: number | null;
  limit: number | null;
  iso_currency_code: string | null;
  unofficial_currency_code?: string | null;
}

export interface PlaidAccount {
  account_id: string;
  balances: PlaidBalances;
  mask: string | null;
  name: string;
  official_name?: string | null;
  type: string;
  subtype: string | null;
}

export interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  amount: number;
  iso_currency_code: string | null;
  unofficial_currency_code?: string | null;
  date: string;
  authorized_date?: string | null;
  name: string;
  merchant_name?: string | null;
  pending: boolean;
  pending_transaction_id: string | null;
  personal_finance_category?: { primary?: string; detailed?: string } | null;
}

interface SyncPage {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: { transaction_id: string }[];
  accounts?: PlaidAccount[];
  next_cursor: string;
  has_more: boolean;
}

interface PlaidSecurity {
  security_id: string;
  ticker_symbol: string | null;
  name: string | null;
  type: string | null;
  is_cash_equivalent?: boolean | null;
  iso_currency_code?: string | null;
  market_identifier_code?: string | null;
  proxy_security_id?: string | null;
}

interface PlaidHolding {
  account_id: string;
  security_id: string;
  quantity: number;
  institution_price: number;
  institution_price_as_of?: string | null;
  institution_value?: number;
  cost_basis: number | null;
  iso_currency_code: string | null;
  tax_lots?: PlaidTaxLot[] | null;
}

interface PlaidTaxLot {
  id?: string | null;
  lot_id?: string | null;
  quantity: number;
  cost_basis: number;
  acquired_date?: string | null;
  purchase_date?: string | null;
  date?: string | null;
}

interface PlaidInvestmentTransaction {
  investment_transaction_id: string;
  account_id: string;
  security_id: string | null;
  date: string;
  name: string;
  quantity: number;
  amount: number;
  price: number;
  fees: number | null;
  type: string;
  subtype: string;
  iso_currency_code: string | null;
}

function plaidHost(ctx: ConnectorContext): string {
  return optionalSecret(ctx, 'PLAID_ENV') === 'sandbox' ? HOSTS.sandbox : HOSTS.production;
}

function client(ctx: ConnectorContext): HttpClient {
  return new HttpClient(ctx, {
    provider: 'Plaid',
    baseUrl: plaidHost(ctx),
    headers: {
      'PLAID-CLIENT-ID': appSecret(ctx, 'PLAID_CLIENT_ID', 'Plaid'),
      'PLAID-SECRET': appSecret(ctx, 'PLAID_SECRET', 'Plaid'),
    },
    repairStatuses: [401],
    needsRepair: (status, body) => {
      const code = (body as PlaidError | null)?.error_code;
      return status === 400 && code && REPAIR_CODES.has(code)
        ? 'the bank login needs your attention'
        : null;
    },
  });
}

function plaidErrorCode(error: unknown): string | null {
  if (error instanceof ProviderHttpError) {
    try {
      return (JSON.parse(error.detail) as PlaidError).error_code ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

export function mapPlaidAccountType(
  type: string,
  subtype: string | null,
): { type: AccountType; subtype: AccountSubtype | null } {
  const sub = (subtype ?? '').toLowerCase();
  switch (type) {
    case 'depository':
      if (sub === 'savings') return { type: 'savings', subtype: null };
      if (sub === 'hsa') return { type: 'savings', subtype: 'hsa' };
      if (sub === 'cd') return { type: 'savings', subtype: 'cd' };
      if (sub === 'money market') return { type: 'savings', subtype: 'money_market' };
      return { type: 'checking', subtype: null };
    case 'credit':
      return { type: 'credit_card', subtype: null };
    case 'loan':
      if (sub === 'mortgage') return { type: 'mortgage', subtype: null };
      if (sub === 'student') return { type: 'loan', subtype: 'student_loan' };
      if (sub === 'auto') return { type: 'loan', subtype: 'auto_loan' };
      if (sub === 'home equity') return { type: 'loan', subtype: 'heloc' };
      return { type: 'loan', subtype: null };
    case 'investment': {
      const retirement: Record<string, AccountSubtype> = {
        '401k': '401k',
        'roth 401k': 'roth_401k',
        ira: 'ira',
        roth: 'roth_ira',
        '529': '529',
        hsa: 'hsa',
      };
      if (sub in retirement) {
        return {
          type: sub === '529' || sub === 'hsa' ? 'brokerage' : 'retirement',
          subtype: retirement[sub] ?? null,
        };
      }
      if (/403b|457b|pension|sep ira|simple ira|retirement/.test(sub))
        return { type: 'retirement', subtype: null };
      return { type: 'brokerage', subtype: sub === 'brokerage' ? 'taxable' : null };
    }
    default:
      return { type: 'other_asset', subtype: null };
  }
}

function currencyOf(c: {
  iso_currency_code: string | null;
  unofficial_currency_code?: string | null;
}): string {
  return (c.iso_currency_code ?? c.unofficial_currency_code ?? 'USD').toUpperCase();
}

export function mapPlaidAccount(a: PlaidAccount): ProviderAccount {
  const { type, subtype } = mapPlaidAccountType(a.type, a.subtype);
  const currency = currencyOf(a.balances);
  const liability = type === 'credit_card' || type === 'loan' || type === 'mortgage';
  return providerAccount({
    externalId: a.account_id,
    name: a.name,
    type,
    subtype,
    currency,
    // Plaid current: assets = what you have, liabilities = what you owe (positive). Same as the model.
    balance: toMinor(a.balances.current ?? 0, currency),
    availableBalance: liability ? null : toMinorOrNull(a.balances.available, currency),
    creditLimit: liability ? toMinorOrNull(a.balances.limit, currency) : null,
    mask: a.mask,
  });
}

export function mapPlaidTransaction(t: PlaidTransaction, fallbackCurrency: string) {
  const currency = t.iso_currency_code || t.unofficial_currency_code || fallbackCurrency;
  const date = toLocalDate(t.date);
  if (!date) throw new ProviderDataError('Plaid', `date of ${t.transaction_id}`);
  return providerTransaction({
    externalId: t.transaction_id,
    accountExternalId: t.account_id,
    date,
    // Plaid: positive = money out. The model: negative = money out.
    amount: negate(toMinor(t.amount, currency)),
    currency,
    rawName: t.name,
    merchantName: t.merchant_name ?? null,
    pending: t.pending,
    pendingExternalId: t.pending_transaction_id,
    categoryHint:
      t.personal_finance_category?.detailed ?? t.personal_finance_category?.primary ?? null,
  });
}

const SECURITY_TYPES: Record<string, SecurityType> = {
  equity: 'equity',
  etf: 'etf',
  'mutual fund': 'mutual_fund',
  'fixed income': 'bond',
  cryptocurrency: 'crypto',
  cash: 'cash',
  derivative: 'option',
};

function mapLots(h: PlaidHolding, currency: string): ProviderTaxLot[] | null {
  if (!Array.isArray(h.tax_lots)) return null;
  const lots: ProviderTaxLot[] = [];
  for (const lot of h.tax_lots) {
    const acquiredOn = toLocalDate(lot.acquired_date ?? lot.purchase_date ?? lot.date);
    const quantity = toDecimalString(lot.quantity);
    if (!acquiredOn || !quantity) continue;
    lots.push({
      externalId: lot.id ?? lot.lot_id ?? null,
      acquiredOn,
      quantity: absDecimal(quantity),
      costBasis: toMinor(lot.cost_basis, currency),
      currency,
    });
  }
  return lots;
}

export function mapPlaidHoldings(
  holdings: PlaidHolding[],
  securities: PlaidSecurity[],
  fallbackCurrency: (accountId: string) => string,
): ProviderHolding[] {
  const byId = new Map(securities.map((s) => [s.security_id, s]));
  const out: ProviderHolding[] = [];
  for (const h of holdings) {
    let sec = byId.get(h.security_id);
    if (sec && !sec.ticker_symbol && sec.proxy_security_id)
      sec = byId.get(sec.proxy_security_id) ?? sec;
    if (!sec?.ticker_symbol) continue; // unresolved or brokerage cash, like Sure
    const type = SECURITY_TYPES[(sec.type ?? '').toLowerCase()] ?? 'other';
    if (type === 'cash') continue; // brokerage cash is part of the account balance, not a holding
    const quantity = toDecimalString(h.quantity);
    const price = toDecimalString(h.institution_price);
    if (!quantity || !price) continue;
    const currency = (
      h.iso_currency_code ??
      sec.iso_currency_code ??
      fallbackCurrency(h.account_id)
    ).toUpperCase();
    out.push({
      accountExternalId: h.account_id,
      symbol: sec.ticker_symbol,
      name: sec.name ?? sec.ticker_symbol,
      securityType: type,
      exchange: toExchangeCode(sec.market_identifier_code),
      quantity,
      price,
      currency,
      costBasis: toMinorOrNull(h.cost_basis, currency),
      lots: mapLots(h, currency),
    });
  }
  return out;
}

export function mapPlaidActivity(
  t: PlaidInvestmentTransaction,
  securities: Map<string, PlaidSecurity>,
  fallbackCurrency: string,
): ProviderActivity | null {
  const date = toLocalDate(t.date);
  if (!date) return null;
  const currency = (t.iso_currency_code ?? fallbackCurrency).toUpperCase();
  const sub = t.subtype.toLowerCase();
  let type: InvestmentActivityType | null = null;
  if (t.type === 'buy') type = sub === 'dividend reinvestment' ? 'reinvest' : 'buy';
  else if (t.type === 'sell') type = 'sell';
  else if (t.type === 'fee') type = 'fee';
  else if (t.type === 'transfer') type = t.quantity < 0 ? 'transfer_out' : 'transfer_in';
  else if (t.type === 'cash') {
    if (sub === 'dividend' || sub === 'qualified dividend' || sub === 'non-qualified dividend')
      type = 'dividend';
    else if (sub === 'interest' || sub === 'interest receivable') type = 'interest';
    else if (sub === 'contribution' || sub === 'deposit') type = 'contribution';
    else if (sub === 'withdrawal') type = 'withdrawal';
    else if (sub === 'account fee' || sub === 'legal fee') type = 'fee';
  }
  if (sub === 'stock split' || sub === 'split') type = 'split';
  if (!type) return null;
  const symbol = t.security_id ? (securities.get(t.security_id)?.ticker_symbol ?? null) : null;
  const quantity = toDecimalString(Math.abs(t.quantity));
  const price = toDecimalString(t.price);
  return {
    externalId: t.investment_transaction_id,
    accountExternalId: t.account_id,
    symbol,
    type,
    date,
    quantity: quantity && quantity !== '0' ? quantity : null,
    price: price && price !== '0' ? price : null,
    // Plaid: positive = cash out of the account. Activities: buy negative, sell and dividend positive.
    amount: negate(toMinor(t.amount, currency)),
    fees: toMinor(t.fees ?? 0, currency),
    currency,
    splitRatio: null,
  };
}

export async function syncPlaid(
  ctx: ConnectorContext,
  connection: Connection,
): Promise<SyncResult> {
  const http = client(ctx);
  const accessToken = connectionSecret(ctx, 'PLAID_ACCESS_TOKEN', 'Plaid');
  const auth = { access_token: accessToken };
  const today = todayUtc(ctx.now());
  const saved = parseCursor<{ cursor?: string; invSince?: string }>(connection.syncCursor);
  const result = emptyResult();
  result.deltaOnly = true;

  // Accounts and balances (fresh every time).
  const accountsResp = await http.post<{ accounts: PlaidAccount[] }>('/accounts/get', auth);
  if (!Array.isArray(accountsResp?.accounts)) throw new ProviderDataError('Plaid', 'accounts');
  const plaidAccounts = accountsResp.accounts;
  const currencyByAccount = new Map(
    plaidAccounts.map((a) => [a.account_id, currencyOf(a.balances)]),
  );
  const fallbackCurrency = (id: string) => currencyByAccount.get(id) ?? 'USD';
  result.accounts = plaidAccounts.map(mapPlaidAccount);

  // Transactions: follow has_more; restart once if Plaid says the data moved mid-pagination.
  let cursor = saved?.cursor;
  const startCursor = cursor;
  let restarts = 0;
  const added = new Map<string, PlaidTransaction>();
  const removed = new Set<string>();
  const hasBank = plaidAccounts.some(
    (a) => a.type === 'depository' || a.type === 'credit' || a.type === 'loan',
  );
  if (hasBank) {
    for (let page = 0; page < 500; page++) {
      let resp: SyncPage;
      try {
        resp = await http.post<SyncPage>('/transactions/sync', { ...auth, cursor, count: 500 });
      } catch (error) {
        const code = plaidErrorCode(error);
        if (code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' && restarts < 3) {
          restarts++;
          cursor = startCursor;
          added.clear();
          removed.clear();
          continue;
        }
        throw error;
      }
      for (const t of [...resp.added, ...resp.modified]) {
        added.set(t.transaction_id, t);
        removed.delete(t.transaction_id);
      }
      for (const r of resp.removed) {
        added.delete(r.transaction_id);
        removed.add(r.transaction_id);
      }
      cursor = resp.next_cursor;
      if (!resp.has_more) break;
    }
  }
  for (const t of added.values()) {
    result.transactions.push(mapPlaidTransaction(t, fallbackCurrency(t.account_id)));
  }
  result.removedTransactionExternalIds = [...removed];

  // Investments: holdings now, activity history from the saved date.
  let invSince = saved?.invSince;
  if (plaidAccounts.some((a) => a.type === 'investment')) {
    try {
      const holdingsResp = await http.post<{
        holdings: PlaidHolding[];
        securities: PlaidSecurity[];
        accounts?: PlaidAccount[];
      }>('/investments/holdings/get', auth);
      result.holdings = mapPlaidHoldings(
        holdingsResp.holdings ?? [],
        holdingsResp.securities ?? [],
        fallbackCurrency,
      );

      const start = windowStart(today, invSince ?? null, {
        backfillDays: BACKFILL_DAYS,
        overlapDays: OVERLAP_DAYS,
      });
      const secs = new Map<string, PlaidSecurity>(
        (holdingsResp.securities ?? []).map((s) => [s.security_id, s]),
      );
      for (let offset = 0; offset < 100_000;) {
        const page = await http.post<{
          investment_transactions: PlaidInvestmentTransaction[];
          securities?: PlaidSecurity[];
          total_investment_transactions: number;
        }>('/investments/transactions/get', {
          ...auth,
          start_date: start,
          end_date: today,
          options: { count: 500, offset },
        });
        for (const s of page.securities ?? []) secs.set(s.security_id, s);
        for (const t of page.investment_transactions) {
          const act = mapPlaidActivity(t, secs, fallbackCurrency(t.account_id));
          if (act) result.activities.push(act);
        }
        offset += page.investment_transactions.length;
        if (
          page.investment_transactions.length === 0 ||
          offset >= page.total_investment_transactions
        )
          break;
      }
      invSince = today;
    } catch (error) {
      const code = plaidErrorCode(error);
      if (!(code && SKIP_PRODUCT_CODES.has(code))) throw error;
    }
  }

  // Liabilities: APR for cards, rates for loans.
  if (plaidAccounts.some((a) => a.type === 'credit' || a.type === 'loan')) {
    try {
      const liab = await http.post<{
        liabilities: {
          credit?:
            { account_id: string; aprs?: { apr_percentage: number; apr_type?: string }[] }[] | null;
          mortgage?: { account_id: string; interest_rate?: { percentage: number } | null }[] | null;
          student?: { account_id: string; interest_rate_percentage?: number | null }[] | null;
        };
      }>('/liabilities/get', auth);
      const rates = new Map<string, number>();
      for (const c of liab.liabilities.credit ?? []) {
        const purchase = c.aprs?.find((x) => x.apr_type === 'purchase_apr') ?? c.aprs?.[0];
        if (purchase) rates.set(c.account_id, purchase.apr_percentage);
      }
      for (const m of liab.liabilities.mortgage ?? []) {
        if (m.interest_rate) rates.set(m.account_id, m.interest_rate.percentage);
      }
      for (const s of liab.liabilities.student ?? []) {
        if (s.interest_rate_percentage != null) rates.set(s.account_id, s.interest_rate_percentage);
      }
      for (const a of result.accounts) {
        const rate = rates.get(a.externalId);
        if (rate !== undefined) a.interestRate = toDecimalString(rate);
      }
    } catch (error) {
      const code = plaidErrorCode(error);
      if (!(code && SKIP_PRODUCT_CODES.has(code))) throw error;
    }
  }

  result.nextCursor = encodeCursor({ cursor, invSince });
  return result;
}

/**
 * Link token for Plaid Link in update mode: the repair flow for a login whose
 * state is needs_repair. It reuses the existing Item, so no lifetime slot is spent.
 */
export async function createPlaidUpdateLinkToken(
  ctx: ConnectorContext,
  opts: { userId: string; redirectUri?: string },
): Promise<string> {
  const http = client(ctx);
  const resp = await http.post<{ link_token: string }>('/link/token/create', {
    client_name: 'ManaClaude',
    language: 'en',
    country_codes: ['US'],
    user: { client_user_id: opts.userId },
    access_token: connectionSecret(ctx, 'PLAID_ACCESS_TOKEN', 'Plaid'),
    redirect_uri: opts.redirectUri,
  });
  if (!resp?.link_token) throw new ProviderDataError('Plaid', 'link token');
  return resp.link_token;
}

export const plaidAdapter = defineAdapter({
  id: 'plaid',
  sync: syncPlaid,
  probe: async (ctx) => {
    const token = connectionSecret(ctx, 'PLAID_ACCESS_TOKEN', 'Plaid');
    const resp = await client(ctx).post<{ item?: { error?: PlaidError | null } }>('/item/get', {
      access_token: token,
    });
    const code = resp?.item?.error?.error_code;
    if (code && REPAIR_CODES.has(code))
      throw new ConnectorRepairNeededError('Plaid: the bank login needs your attention');
  },
});
