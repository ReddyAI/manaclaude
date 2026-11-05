import type { Connection, ConnectorContext, ProviderAccount, SyncResult } from '@manaclaude/shared';
import { addDays } from '@manaclaude/shared';
import { HttpClient } from '../../http';
import { signJwtRs256 } from '../../util/crypto';
import { readSince, sinceCursor } from '../../util/cursor';
import { todayUtc, toLocalDate, windowStart } from '../../util/dates';
import { absMinor, toMinor } from '../../util/decimal';
import {
  appSecret,
  connectionSecret,
  defineAdapter,
  emptyResult,
  hashString,
  providerAccount,
  providerTransaction,
} from '../../kit';
import { ProviderDataError, repairNeeded } from '../../errors';

/**
 * Enable Banking (EU and UK open banking), https://enablebanking.com/docs/api,
 * restricted production for your own linked accounts.
 * Follows Sure: app/models/provider/enable_banking.rb (RS256 JWT signed with the
 * application's private key, sessions, balances, paged transactions) and
 * enable_banking_account/processor.rb, enable_banking_entry/processor.rb
 * (CRDT is money in, DBIT money out), enable_banking_item/importer.rb (balance
 * type priority).
 *
 * - Secrets: ENABLEBANKING_APPLICATION_ID and ENABLEBANKING_PRIVATE_KEY (PEM) are
 *   the app's; ENABLEBANKING_SESSION_ID is per bank login (made when the user
 *   approves access at their bank).
 * - Consent lasts days to months. When the session is no longer AUTHORIZED, or
 *   its valid_until date has passed, the connection needs repair, which is a new
 *   approval at the bank.
 * - Cards and loans report the amount owed, so balances are taken as absolute
 *   values (owed is positive).
 * - Pending: status PDNG rows are pending; booked rows (BOOK) have an entry
 *   reference. Rows with no id get one from their content and occurrence.
 */

export const ENABLE_BANKING_API = 'https://api.enablebanking.com';
const BACKFILL_DAYS = 90;
const OVERLAP_DAYS = 10;
const BALANCE_PRIORITY = ['CLBD', 'ITBD', 'OPBD', 'PRCD', 'XPCD', 'CLAV', 'ITAV'];

interface EbAccountData {
  uid: string;
  account_id?: { iban?: string };
  name?: string;
  currency?: string;
  cash_account_type?: string;
  product?: string;
  details?: string;
}
interface EbSession {
  status: string;
  accounts?: string[];
  accounts_data?: EbAccountData[];
  aspsp?: { name?: string; country?: string };
  access?: { valid_until?: string };
}
interface EbBalance {
  balance_type: string;
  balance_amount: { currency: string; amount: string };
  reference_date?: string;
}
interface EbTransaction {
  entry_reference?: string | null;
  transaction_id?: string | null;
  transaction_amount: { currency: string; amount: string };
  credit_debit_indicator: 'CRDT' | 'DBIT';
  status: 'BOOK' | 'PDNG' | string;
  booking_date?: string | null;
  value_date?: string | null;
  transaction_date?: string | null;
  remittance_information?: string[] | null;
  creditor?: { name?: string | null } | null;
  debtor?: { name?: string | null } | null;
  note?: string | null;
}

async function client(ctx: ConnectorContext): Promise<HttpClient> {
  const applicationId = appSecret(ctx, 'ENABLEBANKING_APPLICATION_ID', 'Enable Banking');
  const pem = appSecret(ctx, 'ENABLEBANKING_PRIVATE_KEY', 'Enable Banking');
  const iat = Math.floor(ctx.now().getTime() / 1000);
  const jwt = await signJwtRs256(
    pem,
    { kid: applicationId },
    { iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat, exp: iat + 3600 },
  );
  return new HttpClient(ctx, {
    provider: 'Enable Banking',
    baseUrl: ENABLE_BANKING_API,
    headers: { Authorization: `Bearer ${jwt}` },
    // 401 means our application JWT is wrong (a Worker setup problem), not that the person's consent ended.
    repairStatuses: [403],
    needsRepair: (_s, body) =>
      /EXPIRED_SESSION|SESSION_DOES_NOT_EXIST|CLOSED_SESSION|REVOKED/i.test(JSON.stringify(body))
        ? 'the bank consent ended'
        : null,
  });
}

export function pickBalance(balances: EbBalance[]): EbBalance | undefined {
  for (const type of BALANCE_PRIORITY) {
    const matches = balances.filter((b) => b.balance_type === type);
    if (matches.length > 0) {
      return matches.sort((a, b) =>
        (b.reference_date ?? '').localeCompare(a.reference_date ?? ''),
      )[0];
    }
  }
  return balances[0];
}

export async function syncEnableBanking(
  ctx: ConnectorContext,
  connection: Connection,
): Promise<SyncResult> {
  const http = await client(ctx);
  const sessionId = connectionSecret(ctx, 'ENABLEBANKING_SESSION_ID', 'Enable Banking');
  const today = todayUtc(ctx.now());
  const start = windowStart(today, readSince(connection), {
    backfillDays: BACKFILL_DAYS,
    overlapDays: OVERLAP_DAYS,
  });
  const result = emptyResult();

  const session = await http.get<EbSession>(`/sessions/${encodeURIComponent(sessionId)}`);
  if (!session?.status) throw new ProviderDataError('Enable Banking', 'session');
  const validUntil = session.access?.valid_until ? Date.parse(session.access.valid_until) : null;
  if (
    session.status !== 'AUTHORIZED' ||
    (validUntil !== null && validUntil < ctx.now().getTime())
  ) {
    throw repairNeeded('Enable Banking', 'the bank consent ended');
  }
  const uids = session.accounts_data?.map((a) => a.uid) ?? session.accounts ?? [];
  const data = new Map((session.accounts_data ?? []).map((a) => [a.uid, a]));

  for (const uid of uids) {
    const d = data.get(uid);
    const bal = await http.get<{ balances: EbBalance[] }>(
      `/accounts/${encodeURIComponent(uid)}/balances`,
    );
    const chosen = pickBalance(Array.isArray(bal?.balances) ? bal.balances : []);
    const currency = (chosen?.balance_amount.currency ?? d?.currency ?? 'EUR').toUpperCase();
    const kind = (d?.cash_account_type ?? '').toUpperCase();
    const card = kind === 'CARD' || /card|credit/i.test(d?.product ?? '');
    const loan = kind === 'LOAN' || /loan|mortgage/i.test(d?.product ?? '');
    const raw = toMinor(chosen?.balance_amount.amount ?? 0, currency);
    const acct: ProviderAccount = providerAccount({
      externalId: uid,
      name: d?.name || d?.product || `${session.aspsp?.name ?? 'Bank'} account`,
      institutionName: session.aspsp?.name ?? null,
      type: card ? 'credit_card' : loan ? 'loan' : kind === 'SVGS' ? 'savings' : 'checking',
      currency,
      // Cards and loans: the amount owed, as a positive number.
      balance: card || loan ? absMinor(raw) : raw,
      mask: d?.account_id?.iban ? d.account_id.iban.slice(-4) : null,
    });
    result.accounts.push(acct);

    const occurrences = new Map<string, number>();
    for (const status of ['BOOK', 'PDNG']) {
      let key: string | null = null;
      for (let page = 0; page < 100; page++) {
        const resp: { transactions?: EbTransaction[]; continuation_key?: string | null } =
          await http.get(`/accounts/${encodeURIComponent(uid)}/transactions`, {
            date_from: start,
            date_to: addDays(today, 0),
            transaction_status: status,
            continuation_key: key,
          });
        for (const t of resp.transactions ?? []) {
          const date = toLocalDate(t.booking_date ?? t.transaction_date ?? t.value_date) ?? today;
          const c = (t.transaction_amount.currency || currency).toUpperCase();
          const magnitude = absMinor(toMinor(t.transaction_amount.amount, c));
          const incoming = t.credit_debit_indicator === 'CRDT';
          const remittance = (t.remittance_information ?? []).join(' ').trim();
          const counterparty = (incoming ? t.debtor?.name : t.creditor?.name) ?? null;
          const baseId = t.entry_reference || t.transaction_id;
          const contentKey = [
            uid,
            date,
            incoming ? '+' : '-',
            magnitude,
            remittance,
            counterparty ?? '',
          ].join('|');
          const nth = (occurrences.get(contentKey) ?? 0) + (baseId ? 0 : 1);
          if (!baseId) occurrences.set(contentKey, nth);
          result.transactions.push(
            providerTransaction({
              externalId: baseId ?? `eb_${hashString(contentKey)}${nth > 1 ? `_${nth - 1}` : ''}`,
              accountExternalId: uid,
              date,
              // CRDT is money in (+), DBIT is money out (-).
              amount: incoming ? magnitude : -magnitude,
              currency: c,
              rawName: remittance || counterparty || t.note || 'Bank transaction',
              merchantName: counterparty,
              pending: t.status === 'PDNG',
            }),
          );
        }
        key = resp.continuation_key ?? null;
        if (!key) break;
      }
    }
  }
  result.nextCursor = sinceCursor(today);
  return result;
}

export const enableBankingAdapter = defineAdapter({
  id: 'enable_banking',
  sync: syncEnableBanking,
  probe: async (ctx) => {
    const http = await client(ctx);
    const session = await http.get<EbSession>(
      `/sessions/${encodeURIComponent(connectionSecret(ctx, 'ENABLEBANKING_SESSION_ID', 'Enable Banking'))}`,
    );
    if (session?.status !== 'AUTHORIZED')
      throw repairNeeded('Enable Banking', 'the bank consent ended');
  },
});
