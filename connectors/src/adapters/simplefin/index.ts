import type {
  Connection,
  ConnectorContext,
  ProviderAccount,
  ProviderHolding,
  SyncResult,
} from '@manaclaude/shared';
import { addDays } from '@manaclaude/shared';
import { HttpClient } from '../../http';
import { readSince, sinceCursor } from '../../util/cursor';
import { todayUtc, toLocalDate, windowStart } from '../../util/dates';
import { toDecimalString, toMinor, toMinorOrNull } from '../../util/decimal';
import { inferAccountType, normalizeLiabilityBalance } from '../../util/accountTypes';
import {
  basicAuth,
  connectionSecret,
  defineAdapter,
  emptyResult,
  optionalSecret,
  providerAccount,
  providerTransaction,
} from '../../kit';
import { ProviderDataError, repairNeeded } from '../../errors';

/**
 * SimpleFIN Bridge (https://www.simplefin.org/protocol.html), $15/yr, paid fallback.
 * Follows Sure: app/models/provider/simplefin.rb (access URL, start-date /
 * end-date as epoch seconds, pending=1), simplefin_account/processor.rb
 * (liability balance signs), simplefin_entry/processor.rb (pending rule, card
 * dates), simplefin/account_type_mapper.rb and
 * simplefin_account/investments/holdings_processor.rb.
 *
 * - Secrets: SIMPLEFIN_ACCESS_URL (per login; the setup token claimed once gives
 *   a URL that carries its own user name and password). fetch refuses URLs with
 *   credentials, so they are moved into a Basic header.
 *   SIMPLEFIN_CARD_BALANCE_SIGN ("debt" or "credit") overrides the guess.
 * - Signs: amounts are positive for deposits and negative for withdrawals, the
 *   model's rule. Card and loan balances run through Sure's liability rule.
 * - Pending: a row is pending when `pending` is true, or when `posted` is 0 and
 *   `transacted_at` is set. SimpleFIN gives the posted row a new id and no link,
 *   so the shared sync matches by amount within 8 days.
 * - Repair: 402/403 (access URL revoked or unpaid), or no accounts at all with
 *   a sign-in message.
 */

interface SfTransaction {
  id: string;
  posted: number | string;
  amount: string | number;
  description?: string;
  payee?: string;
  memo?: string;
  transacted_at?: number | string;
  pending?: boolean;
}

interface SfHolding {
  id: string;
  currency?: string;
  cost_basis?: string | number | null;
  description?: string;
  market_value?: string | number;
  purchase_price?: string | number;
  shares?: string | number;
  symbol?: string;
}

interface SfAccount {
  org?: { name?: string; domain?: string; id?: string };
  id: string;
  name: string;
  currency: string;
  balance: string | number;
  'available-balance'?: string | number | null;
  'balance-date'?: number;
  transactions?: SfTransaction[];
  holdings?: SfHolding[];
}

const BACKFILL_DAYS = 90;
const OVERLAP_DAYS = 14;

export function parseAccessUrl(accessUrl: string): { baseUrl: string; authorization: string } {
  const url = new URL(accessUrl);
  const authorization = basicAuth(
    decodeURIComponent(url.username),
    decodeURIComponent(url.password),
  );
  url.username = '';
  url.password = '';
  return { baseUrl: url.toString().replace(/\/$/, ''), authorization };
}

function client(ctx: ConnectorContext): HttpClient {
  const { baseUrl, authorization } = parseAccessUrl(
    connectionSecret(ctx, 'SIMPLEFIN_ACCESS_URL', 'SimpleFIN'),
  );
  return new HttpClient(ctx, {
    provider: 'SimpleFIN',
    baseUrl,
    headers: { Authorization: authorization },
    repairStatuses: [401, 402, 403],
  });
}

export function isSimplefinPending(
  t: Pick<SfTransaction, 'pending' | 'posted' | 'transacted_at'>,
): boolean {
  if (t.pending === true) return true;
  const postedZero = t.posted === 0 || t.posted === '0';
  return postedZero && Number(t.transacted_at ?? 0) > 0;
}

function epoch(value: number | string | undefined): number {
  return Number(value ?? 0);
}

export function mapSimplefinAccount(
  a: SfAccount,
  cardSignOverride: string | undefined,
): ProviderAccount {
  const currency = (a.currency || 'USD').toUpperCase();
  const bal = Number(a.balance);
  const availRaw = a['available-balance'];
  const avail = availRaw === null || availRaw === undefined ? 0 : Number(availRaw);
  const inferred = inferAccountType({
    name: a.name,
    institution: a.org?.name,
    balance: bal,
    availableBalance: availRaw === null || availRaw === undefined ? null : avail,
    hasHoldings: (a.holdings?.length ?? 0) > 0,
  });
  let balance = toMinor(a.balance, currency);
  if (inferred.type === 'credit_card') {
    const observed = bal;
    const owed =
      cardSignOverride === 'debt'
        ? Math.abs(observed)
        : cardSignOverride === 'credit'
          ? -Math.abs(observed)
          : normalizeLiabilityBalance(observed, bal, avail);
    balance = toMinor(owed, currency);
  } else if (inferred.type === 'loan' || inferred.type === 'mortgage') {
    balance = Math.abs(balance);
  }
  return providerAccount({
    externalId: a.id,
    name: a.name,
    institutionName: a.org?.name ?? null,
    type: inferred.type,
    subtype: inferred.subtype,
    currency,
    balance: balance || 0,
    availableBalance:
      inferred.type === 'credit_card' || availRaw == null
        ? null
        : toMinorOrNull(availRaw, currency),
  });
}

export function mapSimplefinHoldings(a: SfAccount): ProviderHolding[] {
  const out: ProviderHolding[] = [];
  for (const h of a.holdings ?? []) {
    const quantity = toDecimalString(h.shares);
    if (!h.id || !quantity || quantity === '0') continue;
    const symbol = (h.symbol ?? '').trim();
    const description = (h.description ?? '').trim();
    const ticker =
      symbol ||
      (description
        ? `CUSTOM:${description
            .replace(/[^a-zA-Z0-9]/g, '_')
            .toUpperCase()
            .slice(0, 24)}`
        : '');
    if (!ticker) continue;
    const currency = (h.currency || a.currency || 'USD').toUpperCase();
    const value = Number(h.market_value ?? 0);
    const price =
      value > 0 ? toDecimalString(value / Number(quantity)) : toDecimalString(h.purchase_price);
    if (!price) continue;
    out.push({
      accountExternalId: a.id,
      symbol: ticker,
      name: description || ticker,
      securityType: 'equity',
      exchange: null,
      quantity,
      price,
      currency,
      // SimpleFIN's cost_basis is the total for the position.
      costBasis: toMinorOrNull(h.cost_basis, currency),
      lots: null,
    });
  }
  return out;
}

export async function syncSimplefin(
  ctx: ConnectorContext,
  connection: Connection,
): Promise<SyncResult> {
  const http = client(ctx);
  const cardSign = optionalSecret(ctx, 'SIMPLEFIN_CARD_BALANCE_SIGN');
  const today = todayUtc(ctx.now());
  const start = windowStart(today, readSince(connection), {
    backfillDays: BACKFILL_DAYS,
    overlapDays: OVERLAP_DAYS,
  });
  const toEpoch = (d: string): number => Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000);

  const resp = await http.get<{ errors?: string[]; accounts?: SfAccount[] }>('/accounts', {
    version: 2,
    'start-date': toEpoch(start),
    'end-date': toEpoch(addDays(today, 1)),
    pending: 1,
  });
  if (!resp || !Array.isArray(resp.accounts)) throw new ProviderDataError('SimpleFIN', 'accounts');
  if (
    resp.accounts.length === 0 &&
    (resp.errors ?? []).some((e) => /auth|login|credential|attention|reconnect/i.test(e))
  ) {
    throw repairNeeded('SimpleFIN', 'the bank asks you to sign in again');
  }

  const result = emptyResult();
  for (const a of resp.accounts as SfAccount[]) {
    const mapped = mapSimplefinAccount(a, cardSign);
    result.accounts.push(mapped);
    result.holdings.push(...mapSimplefinHoldings(a));
    const currency = mapped.currency;
    const isLiability =
      mapped.type === 'credit_card' || mapped.type === 'loan' || mapped.type === 'mortgage';
    for (const t of a.transactions ?? []) {
      const pending = isSimplefinPending(t);
      const posted = epoch(t.posted) > 0 ? toLocalDate(epoch(t.posted)) : null;
      const transacted = epoch(t.transacted_at) > 0 ? toLocalDate(epoch(t.transacted_at)) : null;
      // Cards and loans are dated by purchase day, everything else by posting day.
      const date = (isLiability ? (transacted ?? posted) : (posted ?? transacted)) ?? today;
      const payee = t.payee?.trim();
      const description = t.description?.trim();
      const rawName =
        payee && description && payee !== description
          ? `${payee} - ${description}`
          : payee || description || t.memo || 'Unknown';
      result.transactions.push(
        providerTransaction({
          externalId: t.id,
          accountExternalId: a.id,
          date,
          amount: toMinor(t.amount, currency),
          currency,
          rawName,
          merchantName: payee || null,
          pending,
        }),
      );
    }
  }
  result.nextCursor = sinceCursor(today);
  return result;
}

export const simplefinAdapter = defineAdapter({
  id: 'simplefin',
  sync: syncSimplefin,
  probe: async (ctx) => {
    await client(ctx).get('/info');
  },
});
