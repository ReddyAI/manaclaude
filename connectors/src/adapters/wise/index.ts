import type { Connection, ConnectorContext, SyncResult } from '@manaclaude/shared';
import { addDays } from '@manaclaude/shared';
import { HttpClient } from '../../http';
import { signRsaSha256 } from '../../util/crypto';
import { readSince, sinceCursor } from '../../util/cursor';
import { todayUtc, toLocalDate, windowStart } from '../../util/dates';
import { toMinor } from '../../util/decimal';
import {
  bearer,
  connectionSecret,
  defineAdapter,
  emptyResult,
  optionalSecret,
  providerAccount,
  providerTransaction,
} from '../../kit';
import { ProviderDataError } from '../../errors';

/**
 * Wise (https://docs.wise.com), personal API token. Check at sign-up that your
 * personal account offers API tokens (the brief lists this as open).
 * Follows Sure: app/models/provider/wise.rb (profiles, v4 balances,
 * balance-statements, the SCA challenge that is answered with an RSA signature
 * in the x-2fa-approval header) and wise_account/*.
 *
 * - Secrets: WISE_API_TOKEN (per login); WISE_SCA_PRIVATE_KEY (PEM) only if Wise
 *   asks for strong customer authentication (UK and EU accounts); optional
 *   WISE_BASE_URL (the sandbox).
 * - One account per currency balance of the personal profile. Statement rows are
 *   already signed: DEBIT negative, CREDIT positive. Fees are in totalFees and
 *   already inside the amount for debits, so they are not subtracted again.
 * - A conversion between two of your own balances is marked as a transfer.
 * - Repair: 401, or 403 that the SCA key cannot answer.
 */

export const WISE_API = 'https://api.wise.com';
const BACKFILL_DAYS = 365;
const OVERLAP_DAYS = 14;
const MAX_INTERVAL_DAYS = 365;

interface WiseBalance {
  id: number;
  currency: string;
  amount: { value: number; currency: string };
  type: string;
  name?: string | null;
}
interface WiseRow {
  type: 'DEBIT' | 'CREDIT';
  date: string;
  amount: { value: number; currency: string };
  totalFees?: { value: number; currency: string };
  details: {
    type?: string;
    description?: string;
    paymentReference?: string;
    senderName?: string;
    recipient?: { name?: string };
    merchant?: { name?: string } | null;
  };
  exchangeDetails?: { forAmount?: { value: number; currency: string } } | null;
  referenceNumber: string;
}

function client(ctx: ConnectorContext): HttpClient {
  const key = optionalSecret(ctx, 'WISE_SCA_PRIVATE_KEY');
  return new HttpClient(ctx, {
    provider: 'Wise',
    baseUrl: optionalSecret(ctx, 'WISE_BASE_URL') ?? WISE_API,
    headers: { Authorization: bearer(connectionSecret(ctx, 'WISE_API_TOKEN', 'Wise')) },
    repairStatuses: [401, 403],
    challenge: key
      ? async (res) => {
          const token = res.headers.get('x-2fa-approval');
          return res.status === 403 && token
            ? { 'x-2fa-approval': token, 'X-Signature': await signRsaSha256(key, token) }
            : null;
        }
      : undefined,
  });
}

export async function syncWise(ctx: ConnectorContext, connection: Connection): Promise<SyncResult> {
  const http = client(ctx);
  const today = todayUtc(ctx.now());
  const since = readSince(connection);
  const start = windowStart(today, since, {
    backfillDays: BACKFILL_DAYS,
    overlapDays: OVERLAP_DAYS,
  });
  const result = emptyResult();

  const profiles = await http.get<{ id: number; type: string }[]>('/v1/profiles');
  const profile = Array.isArray(profiles)
    ? profiles.find((p) => p.type.toLowerCase() === 'personal')
    : undefined;
  if (!profile) throw new ProviderDataError('Wise', 'no personal profile');

  const balances = await http.get<WiseBalance[]>(`/v4/profiles/${profile.id}/balances`, {
    types: 'STANDARD',
  });
  if (!Array.isArray(balances)) throw new ProviderDataError('Wise', 'balances');
  for (const b of balances) {
    const currency = b.currency.toUpperCase();
    const id = `${profile.id}_${b.id}`;
    result.accounts.push(
      providerAccount({
        externalId: id,
        name: b.name || `Wise ${currency}`,
        institutionName: 'Wise',
        type: 'checking',
        currency,
        balance: toMinor(b.amount.value, currency),
        mask: String(b.id).slice(-4),
      }),
    );
    const from =
      addDays(today, -MAX_INTERVAL_DAYS) > start ? addDays(today, -MAX_INTERVAL_DAYS) : start;
    const statement = await http.get<{ transactions: WiseRow[] }>(
      `/v1/profiles/${profile.id}/balance-statements/${b.id}/statement.json`,
      {
        currency,
        intervalStart: `${from}T00:00:00.000Z`,
        intervalEnd: `${today}T23:59:59.999Z`,
        type: 'COMPACT',
      },
    );
    if (!Array.isArray(statement?.transactions)) throw new ProviderDataError('Wise', 'statement');
    for (const t of statement.transactions) {
      const date = toLocalDate(t.date);
      if (!date) continue;
      const counterparty =
        t.details.merchant?.name ?? t.details.recipient?.name ?? t.details.senderName ?? null;
      const rawName =
        t.details.description ||
        t.details.paymentReference ||
        counterparty ||
        t.details.type ||
        'Wise transaction';
      const foreign = t.exchangeDetails?.forAmount;
      result.transactions.push(
        providerTransaction({
          externalId: t.referenceNumber,
          accountExternalId: id,
          date,
          // Wise: DEBIT rows carry a negative value, CREDIT rows a positive one.
          amount: toMinor(t.amount.value, currency),
          currency,
          originalAmount:
            foreign && foreign.currency !== currency
              ? toMinor(
                  t.type === 'DEBIT' ? -Math.abs(foreign.value) : Math.abs(foreign.value),
                  foreign.currency,
                )
              : null,
          originalCurrency:
            foreign && foreign.currency !== currency ? foreign.currency.toUpperCase() : null,
          rawName,
          merchantName: counterparty,
          kindHint: t.details.type === 'CONVERSION' ? 'transfer' : null,
        }),
      );
    }
  }
  result.nextCursor = sinceCursor(today);
  return result;
}

export const wiseAdapter = defineAdapter({
  id: 'wise',
  sync: syncWise,
  probe: async (ctx) => {
    await client(ctx).get('/v1/profiles');
  },
});
