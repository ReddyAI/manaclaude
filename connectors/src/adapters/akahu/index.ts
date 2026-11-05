import type { AccountType, Connection, ConnectorContext, SyncResult } from '@manaclaude/shared';
import { HttpClient } from '../../http';
import { readSince, sinceCursor } from '../../util/cursor';
import { todayUtc, toLocalDate, windowStart } from '../../util/dates';
import { toMinor, toMinorOrNull } from '../../util/decimal';
import {
  bearer,
  connectionSecret,
  defineAdapter,
  emptyResult,
  providerAccount,
  providerTransaction,
  appSecret,
} from '../../kit';
import { ProviderDataError } from '../../errors';

/**
 * Akahu (New Zealand), https://developers.akahu.nz, free for your own data.
 * Follows Sure: app/models/provider/akahu.rb (Bearer user token plus
 * X-Akahu-Id app token, cursor pages, pending transactions endpoint) and
 * akahu_entry/processor.rb (signs).
 *
 * - Secrets: AKAHU_APP_TOKEN (the app id token) and AKAHU_USER_TOKEN (personal
 *   user access token); both come from my.akahu.nz.
 * - Signs: Akahu amounts are negative for money out, the model's rule. Credit
 *   card and loan balances come negative when owed and are negated.
 * - Pending: /transactions/pending rows get an id from their content; the
 *   settled row arrives later with a new id and is matched by amount.
 * - Repair: 401/403 (user token revoked or expired).
 */

export const AKAHU_API = 'https://api.akahu.io/v1';
const BACKFILL_DAYS = 365;
const OVERLAP_DAYS = 14;

interface AkAccount {
  _id: string;
  name: string;
  status?: string;
  formatted_account?: string;
  type: string;
  connection?: { name?: string };
  balance?: { current?: number; available?: number; limit?: number; currency?: string };
}
interface AkTransaction {
  _id: string;
  _account?: string;
  date: string;
  description: string;
  amount: number;
  merchant?: { name?: string } | null;
  category?: { name?: string } | null;
}
interface AkPending {
  _account: string;
  updated_at: string;
  date: string;
  description: string;
  amount: number;
  type?: string;
}

function mapType(type: string): AccountType {
  switch (type.toUpperCase()) {
    case 'SAVINGS':
    case 'TERMDEPOSIT':
    case 'KIWISAVER':
      return type.toUpperCase() === 'KIWISAVER' ? 'retirement' : 'savings';
    case 'CREDITCARD':
      return 'credit_card';
    case 'LOAN':
      return 'loan';
    case 'INVESTMENT':
      return 'brokerage';
    default:
      return 'checking';
  }
}

function client(ctx: ConnectorContext): HttpClient {
  return new HttpClient(ctx, {
    provider: 'Akahu',
    baseUrl: AKAHU_API,
    headers: {
      Authorization: bearer(connectionSecret(ctx, 'AKAHU_USER_TOKEN', 'Akahu')),
      'X-Akahu-Id': appSecret(ctx, 'AKAHU_APP_TOKEN', 'Akahu'),
    },
  });
}

export async function syncAkahu(
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

  const accounts = await http.get<{ items: AkAccount[] }>('/accounts');
  if (!Array.isArray(accounts?.items)) throw new ProviderDataError('Akahu', 'accounts');
  const active = accounts.items.filter((a) => !a.status || a.status === 'ACTIVE');
  const ids = new Set(active.map((a) => a._id));

  for (const a of active) {
    const currency = (a.balance?.currency ?? 'NZD').toUpperCase();
    const type = mapType(a.type);
    const liability = type === 'credit_card' || type === 'loan';
    const current = toMinor(a.balance?.current ?? 0, currency);
    result.accounts.push(
      providerAccount({
        externalId: a._id,
        name: a.name,
        institutionName: a.connection?.name ?? null,
        type,
        currency,
        balance: (liability ? -current : current) || 0,
        availableBalance: liability ? null : toMinorOrNull(a.balance?.available, currency),
        creditLimit: liability ? toMinorOrNull(a.balance?.limit, currency) : null,
        mask: a.formatted_account ? a.formatted_account.slice(-4) : null,
      }),
    );
    let cursor: string | null = null;
    for (let page = 0; page < 200; page++) {
      const resp: { items: AkTransaction[]; cursor?: { next?: string | null } } = await http.get(
        `/accounts/${encodeURIComponent(a._id)}/transactions`,
        { start: `${start}T00:00:00Z`, end: `${today}T23:59:59Z`, cursor },
      );
      if (!Array.isArray(resp?.items)) throw new ProviderDataError('Akahu', 'transactions');
      for (const t of resp.items) {
        const date = toLocalDate(t.date);
        if (!date) continue;
        result.transactions.push(
          providerTransaction({
            externalId: t._id,
            accountExternalId: a._id,
            date,
            amount: toMinor(t.amount, currency),
            currency,
            rawName: t.description,
            merchantName: t.merchant?.name ?? null,
            categoryHint: t.category?.name ?? null,
          }),
        );
      }
      cursor = resp.cursor?.next ?? null;
      if (!cursor) break;
    }
  }

  // Pending rows have no id of their own: key them by content, nth identical gets a suffix.
  const pending = await http.get<{ items: AkPending[] }>('/transactions/pending');
  const seen = new Map<string, number>();
  for (const p of pending?.items ?? []) {
    if (!ids.has(p._account)) continue;
    const date = toLocalDate(p.date);
    if (!date) continue;
    const acct = result.accounts.find((x) => x.externalId === p._account);
    const key = [p._account, date, p.amount, p.description].join('|');
    const nth = (seen.get(key) ?? 0) + 1;
    seen.set(key, nth);
    result.transactions.push(
      providerTransaction({
        externalId: `pending_${key.replace(/[^a-zA-Z0-9]+/g, '_')}${nth > 1 ? `_${nth - 1}` : ''}`,
        accountExternalId: p._account,
        date,
        amount: toMinor(p.amount, acct?.currency ?? 'NZD'),
        currency: acct?.currency ?? 'NZD',
        rawName: p.description,
        pending: true,
      }),
    );
  }
  result.nextCursor = sinceCursor(today);
  return result;
}

export const akahuAdapter = defineAdapter({
  id: 'akahu',
  sync: syncAkahu,
  probe: async (ctx) => {
    await client(ctx).get('/me');
  },
});
