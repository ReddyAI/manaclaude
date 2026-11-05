import type { Connection, ConnectorContext, SyncResult } from '@manaclaude/shared';
import { HttpClient } from '../../http';
import { readSince, sinceCursor } from '../../util/cursor';
import { todayUtc, toLocalDate, windowStart } from '../../util/dates';
import { asMinor, toMinor, toMinorOrNull } from '../../util/decimal';
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
 * Up (Australia), https://developer.up.com.au, personal access token.
 * Follows Sure: app/models/provider/up.rb (JSON:API pages via links.next,
 * HELD and SETTLED rows), up_account/processor.rb (loan balance is absolute),
 * up_entry/processor.rb (HELD is pending; a row with no id is keyed by a
 * content hash; transferAccount marks a movement between your own accounts).
 *
 * - Secrets: UP_ACCESS_TOKEN (per login).
 * - Signs: Up amounts are negative for money out, the model's rule.
 * - Pending: status HELD; the shared sync matches the SETTLED row by amount.
 * - Transfers: a transaction with a transferAccount relationship (including
 *   round-ups into a Saver) is marked kind "transfer" when first stored.
 * - Repair: 401 (token revoked).
 */

export const UP_API = 'https://api.up.com.au/api/v1';
const BACKFILL_DAYS = 365;
const OVERLAP_DAYS = 14;

interface Money {
  currencyCode: string;
  value: string;
  valueInBaseUnits: number;
}
interface UpAccount {
  id: string;
  attributes: {
    displayName: string;
    accountType: 'SAVER' | 'TRANSACTIONAL' | 'HOME_LOAN';
    balance: Money;
  };
}
interface UpTransaction {
  id: string | null;
  attributes: {
    status: 'HELD' | 'SETTLED';
    rawText?: string | null;
    description: string;
    message?: string | null;
    amount: Money;
    foreignAmount?: Money | null;
    settledAt?: string | null;
    createdAt: string;
  };
  relationships?: { transferAccount?: { data?: { id: string } | null } };
}
interface Page<T> {
  data: T[];
  links?: { next?: string | null };
}

function client(ctx: ConnectorContext): HttpClient {
  return new HttpClient(ctx, {
    provider: 'Up',
    baseUrl: UP_API,
    headers: { Authorization: bearer(connectionSecret(ctx, 'UP_ACCESS_TOKEN', 'Up')) },
    repairStatuses: [401],
  });
}

async function all<T>(
  http: HttpClient,
  path: string,
  query?: Record<string, string | number>,
): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = null;
  const seen = new Set<string>();
  for (let page = 0; page < 200; page++) {
    const resp: Page<T> = next
      ? await http.get<Page<T>>(next)
      : await http.get<Page<T>>(path, query);
    if (!Array.isArray(resp?.data)) throw new ProviderDataError('Up', 'list');
    out.push(...resp.data);
    next = resp.links?.next ?? null;
    if (!next || seen.has(next)) break;
    seen.add(next);
  }
  return out;
}

export async function syncUp(ctx: ConnectorContext, connection: Connection): Promise<SyncResult> {
  const http = client(ctx);
  const today = todayUtc(ctx.now());
  const start = windowStart(today, readSince(connection), {
    backfillDays: BACKFILL_DAYS,
    overlapDays: OVERLAP_DAYS,
  });
  const result = emptyResult();

  const accounts = await all<UpAccount>(http, '/accounts');
  for (const a of accounts) {
    const currency = a.attributes.balance.currencyCode.toUpperCase();
    const balance = asMinor(a.attributes.balance.valueInBaseUnits);
    const loan = a.attributes.accountType === 'HOME_LOAN';
    result.accounts.push(
      providerAccount({
        externalId: a.id,
        name: a.attributes.displayName,
        institutionName: 'Up',
        type: loan ? 'mortgage' : a.attributes.accountType === 'SAVER' ? 'savings' : 'checking',
        currency,
        // A home loan shows as a negative balance; the model wants what is owed, positive.
        balance: loan ? Math.abs(balance) : balance,
      }),
    );
    const rows = await all<UpTransaction>(
      http,
      `/accounts/${encodeURIComponent(a.id)}/transactions`,
      {
        'page[size]': 100,
        'filter[since]': `${start}T00:00:00Z`,
      },
    );
    const seen = new Map<string, number>();
    for (const t of rows) {
      const date = toLocalDate(t.attributes.settledAt ?? t.attributes.createdAt);
      if (!date) continue;
      const amount = toMinor(t.attributes.amount.value, t.attributes.amount.currencyCode);
      const key = [
        a.id,
        t.attributes.createdAt,
        t.attributes.amount.value,
        t.attributes.description,
      ].join('|');
      const nth = (seen.get(key) ?? 0) + 1;
      seen.set(key, nth);
      const externalId = t.id ?? `pending_${hashString(key)}${nth > 1 ? `_${nth - 1}` : ''}`;
      const fx = t.attributes.foreignAmount;
      result.transactions.push(
        providerTransaction({
          externalId,
          accountExternalId: a.id,
          date,
          amount,
          currency: t.attributes.amount.currencyCode.toUpperCase(),
          originalAmount: fx ? toMinorOrNull(fx.value, fx.currencyCode) : null,
          originalCurrency: fx ? fx.currencyCode.toUpperCase() : null,
          rawName: t.attributes.rawText || t.attributes.description,
          merchantName: t.attributes.description,
          pending: t.attributes.status === 'HELD',
          kindHint: t.relationships?.transferAccount?.data?.id ? 'transfer' : null,
        }),
      );
    }
  }
  result.nextCursor = sinceCursor(today);
  return result;
}

export const upAdapter = defineAdapter({
  id: 'up',
  sync: syncUp,
  probe: async (ctx) => {
    await client(ctx).get('/util/ping');
  },
});
