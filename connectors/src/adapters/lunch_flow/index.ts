import type { Connection, ConnectorContext, ProviderHolding, SyncResult } from '@manaclaude/shared';
import { addDays } from '@manaclaude/shared';
import { HttpClient } from '../../http';
import { readSince, sinceCursor } from '../../util/cursor';
import { todayUtc, toLocalDate, windowStart } from '../../util/dates';
import { toDecimalString, toMinor, toMinorOrNull } from '../../util/decimal';
import { inferAccountType } from '../../util/accountTypes';
import {
  connectionSecret,
  defineAdapter,
  emptyResult,
  hashString,
  providerAccount,
  providerTransaction,
  toExchangeCode,
  guessSecurityType,
} from '../../kit';
import { ProviderDataError, ProviderHttpError } from '../../errors';

/**
 * Lunch Flow (https://lunchflow.app), paid; one API in front of MX, Finicity,
 * Stripe Financial Connections, GoCardless and SnapTrade.
 * Follows Sure: app/models/provider/lunchflow.rb (x-api-key, 501 for holdings
 * not supported), lunchflow_account/processor.rb (card and loan balances come
 * negated), lunchflow_entry/processor.rb (rows without an id are keyed by a
 * content hash plus occurrence, so identical rows stay separate; masked card
 * text marks an unidentified hold), lunchflow_account/investments/holdings_processor.rb.
 *
 * - Secrets: LUNCHFLOW_API_KEY (per account of the service). Optional
 *   LUNCHFLOW_BASE_URL for the API root.
 * - Signs: amounts are positive for money in. Holds with only masked card text
 *   are card authorisations, so they are money out.
 * - Pending: `isPending`; a hold with no id gets a "pending_<hash>" id and the
 *   shared sync later matches it to the posted row by amount.
 * - Repair: 401/403 (key revoked) or a 4xx saying the bank link expired.
 */

export const LUNCHFLOW_API = 'https://lunchflow.app/api/v1';
const BACKFILL_DAYS = 365;
const OVERLAP_DAYS = 14;

interface LfAccount {
  id: number | string;
  name: string;
  institution_name?: string | null;
  provider?: string;
  currency?: string;
  status?: string;
}
interface LfTransaction {
  id?: string | null;
  accountId?: number | string;
  amount: number | string;
  currency?: string;
  date: string;
  merchant?: string | null;
  description?: string | null;
  isPending?: boolean;
}
interface LfHolding {
  security?: {
    tickerSymbol?: string | null;
    name?: string | null;
    currency?: string | null;
    exchange?: string | null;
    type?: string | null;
  };
  quantity: number | string;
  price: number | string;
  value?: number | string;
  costBasis?: number | string | null;
  currency?: string;
}

const MASKED =
  /^(?:card\s*)?(?:[*xX•·#.-]{2,}\s*)?(?:ending\s+(?:in\s+)?)?(?:[*xX•·#.-]{2,}\s*)?\d{4}$/i;
const maskedCardText = (text: string | null | undefined): boolean =>
  !!text && MASKED.test(text.trim());

export function isUnidentifiedHold(t: LfTransaction): boolean {
  if (t.id) return false;
  const fields = [t.merchant, t.description].map((x) => (x ?? '').trim()).filter(Boolean);
  return fields.length > 0 && fields.every(maskedCardText);
}

function client(ctx: ConnectorContext): HttpClient {
  return new HttpClient(ctx, {
    provider: 'Lunch Flow',
    baseUrl: ctx.secrets.LUNCHFLOW_BASE_URL || LUNCHFLOW_API,
    headers: { 'x-api-key': connectionSecret(ctx, 'LUNCHFLOW_API_KEY', 'Lunch Flow') },
  });
}

export async function syncLunchFlow(
  ctx: ConnectorContext,
  connection: Connection,
): Promise<SyncResult> {
  const http = client(ctx);
  const today = todayUtc(ctx.now());
  const start = windowStart(today, readSince(connection), {
    backfillDays: BACKFILL_DAYS,
    overlapDays: OVERLAP_DAYS,
  });
  const result = emptyResult();

  const list = await http.get<{ accounts: LfAccount[] }>('/accounts');
  if (!Array.isArray(list?.accounts)) throw new ProviderDataError('Lunch Flow', 'accounts');

  for (const a of list.accounts) {
    if (a.status && !/active/i.test(a.status)) continue;
    const id = String(a.id);
    const currency = (a.currency ?? 'USD').toUpperCase();
    const encoded = encodeURIComponent(id);
    const bal = await http.get<{ balance?: { amount: number | string; currency?: string } }>(
      `/accounts/${encoded}/balance`,
    );
    const observed = bal?.balance?.amount;
    if (observed === undefined || observed === null) continue; // keep last known balance, like Sure
    const hold = await http
      .get<{ holdings?: LfHolding[] }>(`/accounts/${encoded}/holdings`)
      .catch((error: unknown) => {
        if (error instanceof ProviderHttpError && (error.status === 501 || error.status === 404))
          return { holdings: [] };
        throw error;
      });
    const holdings: ProviderHolding[] = [];
    for (const h of hold?.holdings ?? []) {
      const symbol = h.security?.tickerSymbol?.trim();
      const quantity = toDecimalString(h.quantity);
      const price = toDecimalString(h.price);
      if (!symbol || !quantity || quantity === '0' || !price) continue;
      const hc = (h.currency ?? h.security?.currency ?? currency).toUpperCase();
      holdings.push({
        accountExternalId: id,
        symbol,
        name: h.security?.name ?? symbol,
        securityType: guessSecurityType(symbol, h.security?.type),
        exchange: toExchangeCode(h.security?.exchange),
        quantity,
        price,
        currency: hc,
        costBasis: toMinorOrNull(h.costBasis, hc),
        lots: null,
      });
    }
    const inferred = inferAccountType({
      name: a.name,
      institution: a.institution_name,
      hasHoldings: holdings.length > 0,
    });
    const liability =
      inferred.type === 'credit_card' || inferred.type === 'loan' || inferred.type === 'mortgage';
    // Lunch Flow reports a card or loan balance negative when owed.
    const raw = toMinor(observed, currency);
    result.accounts.push(
      providerAccount({
        externalId: id,
        name: a.name,
        institutionName: a.institution_name ?? null,
        type: inferred.type,
        subtype: inferred.subtype,
        currency: (bal.balance?.currency ?? currency).toUpperCase(),
        balance: (liability ? -raw : raw) || 0,
      }),
    );
    result.holdings.push(...holdings);

    const txResp = await http.get<{ transactions: LfTransaction[] }>(
      `/accounts/${encoded}/transactions`,
      {
        start_date: start,
        end_date: addDays(today, 1),
        include_pending: 'true',
      },
    );
    if (!Array.isArray(txResp?.transactions))
      throw new ProviderDataError('Lunch Flow', 'transactions');
    const seen = new Map<string, number>();
    for (const t of txResp.transactions) {
      const date = toLocalDate(t.date);
      if (!date) continue;
      const tc = (t.currency ?? currency).toUpperCase();
      const hold_ = isUnidentifiedHold(t);
      // Rows with no id are keyed by their content; the nth identical row gets suffix n.
      const key = [id, date, String(t.amount), t.merchant ?? '', t.description ?? ''].join('|');
      const nth = (seen.get(key) ?? 0) + (t.id ? 0 : 1);
      if (!t.id) seen.set(key, nth);
      const externalId = t.id
        ? String(t.id)
        : `pending_${hashString(key)}${nth > 1 ? `_${nth - 1}` : ''}`;
      const amount = toMinor(t.amount, tc);
      const merchant = t.merchant?.trim() || null;
      const useDescription = maskedCardText(merchant) && t.description;
      result.transactions.push(
        providerTransaction({
          externalId,
          accountExternalId: id,
          date,
          // Holds with masked text are card authorisations: money out.
          amount: hold_ ? -Math.abs(amount) : amount,
          currency: tc,
          rawName: hold_
            ? 'Card hold'
            : useDescription
              ? t.description!.trim()
              : (merchant ?? t.description?.trim() ?? 'Unknown'),
          merchantName: hold_ || maskedCardText(merchant) ? null : merchant,
          pending: t.isPending === true || !t.id,
        }),
      );
    }
  }
  result.nextCursor = sinceCursor(today);
  return result;
}

export const lunchFlowAdapter = defineAdapter({
  id: 'lunch_flow',
  sync: syncLunchFlow,
  probe: async (ctx) => {
    await client(ctx).get('/accounts');
  },
});
