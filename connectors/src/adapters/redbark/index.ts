import type { Connection, ConnectorContext, SyncResult } from '@manaclaude/shared';
import { HttpClient } from '../../http';
import { readSince, sinceCursor } from '../../util/cursor';
import { todayUtc, toLocalDate, windowStart } from '../../util/dates';
import { absMinor, toMinor } from '../../util/decimal';
import {
  bearer,
  connectionSecret,
  defineAdapter,
  emptyResult,
  hashString,
  providerAccount,
  providerTransaction,
} from '../../kit';
import { ProviderDataError } from '../../errors';

/**
 * Redbark (Australia), https://redbark.com. Check pricing at sign-up.
 * Follows Sure: app/models/provider/redbark.rb (Bearer API key, limit/offset
 * pages with hasMore, accounts, balances by accountIds, transactions per
 * connection and account) and redbark_account/* (liability balances; ids that
 * Redbark reissues when a hold posts are handled by the shared pending match).
 *
 * - Secrets: REDBARK_API_KEY (per login).
 * - Signs: Redbark's amounts are pre-signed decimal strings, positive for a
 *   credit and negative for a debit, the model's rule. Card and loan balances
 *   are made absolute (owed is positive).
 * - The balances reply shape is not documented publicly; this reads accountId
 *   plus the first of balance, currentBalance, current or amount, and says so in
 *   the README.
 * - Repair: 401/403.
 */

export const REDBARK_API = 'https://api.redbark.com/v1';
const PAGE = 500;
const BACKFILL_DAYS = 365;
const OVERLAP_DAYS = 14;

interface RbAccount {
  id: string;
  connectionId?: string;
  name?: string;
  institutionName?: string;
  type?: string;
  currency?: string | { code?: string };
}
interface RbBalance {
  accountId: string;
  balance?: number | string;
  currentBalance?: number | string;
  current?: number | string;
  amount?: number | string;
  currency?: string;
}
interface RbTransaction {
  id?: string | null;
  accountId?: string;
  status?: string;
  date?: string;
  postDate?: string;
  description?: string;
  amount: string | number;
  merchantName?: string | null;
  category?: string | null;
}

function client(ctx: ConnectorContext): HttpClient {
  return new HttpClient(ctx, {
    provider: 'Redbark',
    baseUrl: REDBARK_API,
    headers: { Authorization: bearer(connectionSecret(ctx, 'REDBARK_API_KEY', 'Redbark')) },
  });
}

async function paged<T>(
  http: HttpClient,
  path: string,
  query: Record<string, string | number | undefined>,
): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0, i = 0; i < 100; i++) {
    const r = await http.get<{ data?: T[]; hasMore?: boolean }>(path, {
      ...query,
      limit: PAGE,
      offset,
    });
    if (!Array.isArray(r?.data)) throw new ProviderDataError('Redbark', 'list');
    out.push(...r.data);
    if (!r.hasMore || r.data.length === 0) break;
    offset += r.data.length;
  }
  return out;
}

export async function syncRedbark(
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

  const accounts = await paged<RbAccount>(http, '/accounts', {});
  const balances =
    accounts.length > 0
      ? await http.get<{ data?: RbBalance[] }>('/balances', {
          accountIds: accounts.map((a) => a.id).join(','),
        })
      : { data: [] };
  const balanceOf = new Map((balances?.data ?? []).map((b) => [b.accountId, b]));

  for (const a of accounts) {
    const b = balanceOf.get(a.id);
    const raw = b?.balance ?? b?.currentBalance ?? b?.current ?? b?.amount;
    if (raw === undefined) continue; // keep the last known balance when this fetch has none, like Sure
    const currency = (
      (typeof a.currency === 'string' ? a.currency : a.currency?.code) ??
      b?.currency ??
      'AUD'
    ).toUpperCase();
    const type = /credit|card/i.test(a.type ?? '')
      ? 'credit_card'
      : /loan|mortgage/i.test(a.type ?? '')
        ? 'loan'
        : /sav/i.test(a.type ?? '')
          ? 'savings'
          : 'checking';
    const minor = toMinor(raw, currency);
    result.accounts.push(
      providerAccount({
        externalId: a.id,
        name: a.name ?? `${a.institutionName ?? 'Redbark'} account`,
        institutionName: a.institutionName ?? null,
        type,
        currency,
        balance: type === 'credit_card' || type === 'loan' ? absMinor(minor) : minor,
      }),
    );

    const rows = await paged<RbTransaction>(http, '/transactions', {
      connectionId: a.connectionId,
      accountId: a.id,
      from: start,
      to: today,
      includePending: 'true',
    });
    const seen = new Map<string, number>();
    for (const t of rows) {
      const date = toLocalDate(t.date ?? t.postDate);
      if (!date) continue;
      const key = [a.id, date, String(t.amount), t.description ?? ''].join('|');
      const nth = (seen.get(key) ?? 0) + (t.id ? 0 : 1);
      if (!t.id) seen.set(key, nth);
      result.transactions.push(
        providerTransaction({
          externalId: t.id ?? `pending_${hashString(key)}${nth > 1 ? `_${nth - 1}` : ''}`,
          accountExternalId: a.id,
          date,
          // Pre-signed: positive = credit, negative = debit.
          amount: toMinor(t.amount, currency),
          currency,
          rawName: t.description || t.merchantName || 'Bank transaction',
          merchantName: t.merchantName ?? null,
          pending: (t.status ?? '').toLowerCase() === 'pending',
          categoryHint: t.category ?? null,
        }),
      );
    }
  }
  result.nextCursor = sinceCursor(today);
  return result;
}

export const redbarkAdapter = defineAdapter({
  id: 'redbark',
  sync: syncRedbark,
  probe: async (ctx) => {
    await client(ctx).get('/connections');
  },
});
