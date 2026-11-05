import type {
  AccountSubtype,
  AccountType,
  Connection,
  ConnectorContext,
  ProviderAccount,
  ProviderTransaction,
  SyncResult,
} from '@manaclaude/shared';
import { todayUtc, windowStart, toLocalDate } from '../../util/dates';
import { toMinor } from '../../util/decimal';
import { HttpClient } from '../../http';
import { readSince, sinceCursor } from '../../util/cursor';
import {
  basicAuth,
  connectionSecret,
  defineAdapter,
  emptyResult,
  providerAccount,
  providerTransaction,
} from '../../kit';
import { ProviderDataError } from '../../errors';

/**
 * Teller (https://teller.io/docs/api). Not in Sure; written from Teller's docs.
 *
 * - Auth: HTTP Basic, access token as the user name, empty password. In
 *   development and production Teller also needs the application's client
 *   certificate: the Worker passes a ctx.fetch bound to the mTLS binding.
 * - Secrets: TELLER_ACCESS_TOKEN (per login; the enrollment's token).
 * - Signs: Teller reports money out as negative for every account type, which
 *   is the model's rule, so amounts pass through. Credit card balances come as
 *   the amount owed (positive), which is also the model's rule for liabilities.
 * - Pending: a pending row has status "pending". Teller may give the posted row
 *   a new id and does not link them, so the shared sync matches by amount.
 * - Errors: 401, or 404 with an error code starting "enrollment.disconnected",
 *   means the user must reconnect (Teller Connect with the same enrollment id).
 */

export const TELLER_API = 'https://api.teller.io';
const PAGE_SIZE = 100;
const BACKFILL_DAYS = 730;
const OVERLAP_DAYS = 14;

export interface TellerAccount {
  id: string;
  enrollment_id?: string;
  institution: { id: string; name: string };
  name: string;
  type: 'depository' | 'credit';
  subtype: string;
  currency: string;
  last_four?: string | null;
  status: 'open' | 'closed';
}

export interface TellerBalances {
  account_id: string;
  ledger: string | null;
  available: string | null;
}

export interface TellerTransaction {
  id: string;
  account_id: string;
  date: string;
  description: string;
  status: 'posted' | 'pending';
  amount: string;
  running_balance?: string | null;
  type?: string;
  details?: {
    category?: string | null;
    processing_status?: string;
    counterparty?: { name?: string | null; type?: string | null } | null;
  };
}

function mapType(a: TellerAccount): { type: AccountType; subtype: AccountSubtype | null } {
  if (a.type === 'credit') return { type: 'credit_card', subtype: null };
  switch (a.subtype) {
    case 'savings':
      return { type: 'savings', subtype: null };
    case 'money_market':
      return { type: 'savings', subtype: 'money_market' };
    case 'certificate_of_deposit':
      return { type: 'savings', subtype: 'cd' };
    default:
      return { type: 'checking', subtype: null };
  }
}

function client(ctx: ConnectorContext): HttpClient {
  const token = connectionSecret(ctx, 'TELLER_ACCESS_TOKEN', 'Teller');
  return new HttpClient(ctx, {
    provider: 'Teller',
    baseUrl: TELLER_API,
    headers: { Authorization: basicAuth(token, '') },
    needsRepair: (status, body) => {
      const code = (body as { error?: { code?: string } } | null)?.error?.code;
      return status === 404 &&
        typeof code === 'string' &&
        code.startsWith('enrollment.disconnected')
        ? 'bank connection needs your attention'
        : null;
    },
  });
}

export function mapTellerTransaction(t: TellerTransaction, currency: string): ProviderTransaction {
  const date = toLocalDate(t.date);
  if (!date) throw new ProviderDataError('Teller', `date of ${t.id}`);
  const counterparty = t.details?.counterparty?.name?.trim() || null;
  return providerTransaction({
    externalId: t.id,
    accountExternalId: t.account_id,
    date,
    // Teller already signs money out as negative.
    amount: toMinor(t.amount, currency),
    currency,
    rawName: t.description,
    merchantName: counterparty,
    pending: t.status === 'pending',
    categoryHint: t.details?.category ?? null,
  });
}

async function fetchTransactions(
  http: HttpClient,
  accountId: string,
  currency: string,
  start: string,
): Promise<ProviderTransaction[]> {
  const out: ProviderTransaction[] = [];
  let fromId: string | undefined;
  for (let page = 0; page < 500; page++) {
    const rows = await http.get<TellerTransaction[]>(`/accounts/${accountId}/transactions`, {
      count: PAGE_SIZE,
      from_id: fromId,
    });
    if (!Array.isArray(rows)) throw new ProviderDataError('Teller', 'transactions list');
    if (rows.length === 0) break;
    for (const t of rows) out.push(mapTellerTransaction(t, currency));
    const oldest = rows[rows.length - 1] as TellerTransaction;
    // Newest first: once a page reaches back past the window, stop. Otherwise ask for the next page.
    if ((toLocalDate(oldest.date) ?? '9999') < start) break;
    fromId = oldest.id;
  }
  return out.filter((t) => t.date >= start);
}

export async function syncTeller(
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

  const accounts = await http.get<TellerAccount[]>('/accounts');
  if (!Array.isArray(accounts)) throw new ProviderDataError('Teller', 'accounts list');

  for (const a of accounts) {
    if (a.status === 'closed') continue;
    const balances = await http.get<TellerBalances>(`/accounts/${a.id}/balances`);
    const { type, subtype } = mapType(a);
    const isCard = type === 'credit_card';
    const ledger = toMinor(balances.ledger, a.currency);
    const available = balances.available === null ? null : toMinor(balances.available, a.currency);
    const acct: ProviderAccount = providerAccount({
      externalId: a.id,
      name: a.name,
      institutionName: a.institution.name,
      type,
      subtype,
      currency: a.currency,
      // Card: ledger is what is owed. Bank: ledger is what is there.
      balance: ledger,
      availableBalance: isCard ? null : available,
      creditLimit: isCard && available !== null ? ledger + available : null,
      mask: a.last_four ?? null,
    });
    result.accounts.push(acct);
    result.transactions.push(...(await fetchTransactions(http, a.id, a.currency, start)));
  }
  result.nextCursor = sinceCursor(today);
  return result;
}

export const tellerAdapter = defineAdapter({
  id: 'teller',
  sync: syncTeller,
  probe: async (ctx) => {
    await client(ctx).get('/accounts');
  },
});
