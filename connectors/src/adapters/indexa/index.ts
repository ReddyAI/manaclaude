import type {
  Connection,
  ConnectorContext,
  ProviderHolding,
  ProviderTaxLot,
  SyncResult,
} from '@manaclaude/shared';
import { HttpClient } from '../../http';
import { sinceCursor } from '../../util/cursor';
import { todayUtc, toLocalDate } from '../../util/dates';
import { toDecimalString, toMinor } from '../../util/decimal';
import { connectionSecret, defineAdapter, emptyResult, providerAccount } from '../../kit';
import { ProviderDataError } from '../../errors';

/**
 * Indexa Capital (Spain), https://indexacapital.com/en/api, personal API token.
 * Follows Sure: app/models/provider/indexa_capital.rb (X-AUTH-TOKEN, users/me,
 * fiscal-results as holdings with cost basis, portfolio as the fallback,
 * performance for the balance, no activity endpoint) and
 * indexa_capital_account/holdings_processor.rb.
 *
 * - Secrets: INDEXA_API_TOKEN (per login; from the Indexa web app, under your
 *   user settings).
 * - Accounts are in EUR. Mutual fund accounts are taxable brokerage accounts;
 *   pension and EPSV plans are retirement accounts.
 * - Fiscal results list one row per purchase (subscription_date, titles,
 *   cost_price), which are real tax lots, so lots come from the broker.
 *   Indexa has no transaction history; cost comes from the same rows.
 * - Repair: 401/403 (token revoked).
 */

export const INDEXA_API = 'https://api.indexacapital.com';

interface IxAccount {
  account_number: string;
  type: string;
  status?: string;
}
interface IxInstrument {
  identifier?: string;
  name?: string;
}
interface IxRow {
  instrument?: IxInstrument;
  titles?: number;
  price?: number;
  amount?: number;
  cost_price?: number;
  cost_amount?: number;
  subscription_date?: string;
}

function client(ctx: ConnectorContext): HttpClient {
  return new HttpClient(ctx, {
    provider: 'Indexa Capital',
    baseUrl: INDEXA_API,
    headers: { 'X-AUTH-TOKEN': connectionSecret(ctx, 'INDEXA_API_TOKEN', 'Indexa Capital') },
  });
}

export async function syncIndexa(
  ctx: ConnectorContext,
  _connection: Connection,
): Promise<SyncResult> {
  void _connection;
  const http = client(ctx);
  const today = todayUtc(ctx.now());
  const result = emptyResult();

  const me = await http.get<{ accounts: IxAccount[] }>('/users/me');
  if (!Array.isArray(me?.accounts)) throw new ProviderDataError('Indexa Capital', 'users/me');
  for (const a of me.accounts) {
    if (a.status && a.status !== 'active') continue;
    const number = a.account_number;
    const perf = await http.get<{ portfolios?: { date: string; total_amount: number }[] }>(
      `/accounts/${encodeURIComponent(number)}/performance`,
    );
    const latest = [...(perf.portfolios ?? [])].sort((x, y) => y.date.localeCompare(x.date))[0];
    const pension = /pension|epsv/i.test(a.type);
    result.accounts.push(
      providerAccount({
        externalId: number,
        name: `Indexa Capital ${pension ? 'Pension Plan' : 'Mutual Fund'} (${number})`,
        institutionName: 'Indexa Capital',
        type: pension ? 'retirement' : 'brokerage',
        subtype: pension ? 'pension' : 'taxable',
        currency: 'EUR',
        balance: toMinor(latest?.total_amount ?? 0, 'EUR'),
        mask: number.slice(-4),
      }),
    );

    let rows: IxRow[] = [];
    let totals: IxRow[] = [];
    const fiscal = await http.get<{ fiscal_results?: IxRow[]; total_fiscal_results?: IxRow[] }>(
      `/accounts/${encodeURIComponent(number)}/fiscal-results`,
    );
    rows = fiscal.fiscal_results ?? [];
    totals = fiscal.total_fiscal_results ?? [];
    if (totals.length === 0) {
      // Pension plans: positions are only in the portfolio snapshot.
      const portfolio = await http.get<{ instrument_accounts?: { positions?: IxRow[] }[] }>(
        `/accounts/${encodeURIComponent(number)}/portfolio`,
      );
      totals = (portfolio.instrument_accounts ?? []).flatMap((i) => i.positions ?? []);
    }
    const lotsByIsin = new Map<string, ProviderTaxLot[]>();
    for (const r of rows) {
      const isin = r.instrument?.identifier;
      const acquiredOn = toLocalDate(r.subscription_date);
      const qty = toDecimalString(r.titles);
      if (!isin || !acquiredOn || !qty || qty === '0') continue;
      const list = lotsByIsin.get(isin) ?? [];
      list.push({
        externalId: null,
        acquiredOn,
        quantity: qty,
        costBasis: toMinor(r.cost_amount ?? Number(qty) * (r.cost_price ?? 0), 'EUR'),
        currency: 'EUR',
      });
      lotsByIsin.set(isin, list);
    }
    for (const t of totals) {
      const isin = t.instrument?.identifier;
      const qty = toDecimalString(t.titles);
      const price = toDecimalString(t.price);
      if (!isin || !qty || qty === '0' || !price) continue;
      result.holdings.push({
        accountExternalId: number,
        symbol: isin,
        name: t.instrument?.name ?? isin,
        securityType: 'mutual_fund',
        exchange: null,
        quantity: qty,
        price,
        currency: 'EUR',
        costBasis:
          t.cost_amount !== undefined
            ? toMinor(t.cost_amount, 'EUR')
            : t.cost_price !== undefined
              ? toMinor(Number(qty) * t.cost_price, 'EUR')
              : null,
        lots: lotsByIsin.get(isin) ?? null,
      } satisfies ProviderHolding);
    }
  }
  result.nextCursor = sinceCursor(today);
  return result;
}

export const indexaAdapter = defineAdapter({
  id: 'indexa',
  sync: syncIndexa,
  probe: async (ctx) => {
    await client(ctx).get('/users/me');
  },
});
