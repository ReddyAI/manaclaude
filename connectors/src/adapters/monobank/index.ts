import type { Connection, ConnectorContext, SyncResult } from '@manaclaude/shared';
import { addDays } from '@manaclaude/shared';
import { HttpClient } from '../../http';
import { sinceCursor, readSince } from '../../util/cursor';
import { todayUtc, toLocalDate } from '../../util/dates';
import { asMinor } from '../../util/decimal';
import {
  connectionSecret,
  defineAdapter,
  emptyResult,
  providerAccount,
  providerTransaction,
} from '../../kit';
import { ProviderDataError } from '../../errors';

/**
 * Monobank (Ukraine), https://api.monobank.ua/docs, personal token.
 * Follows Sure: app/models/provider/monobank.rb (X-Token header, client-info,
 * statement windows, one statement call per minute) and monobank_entry/processor.rb.
 *
 * - Secrets: MONOBANK_TOKEN (per login).
 * - Money: balances and statement amounts are already integer minor units in the
 *   account currency; the sign is negative for money out, the model's rule.
 *   Credit cards: balance = money + creditLimit, so debt = creditLimit - balance.
 * - Limits: statements cover at most 31 days and Monobank allows one statement
 *   request a minute per account, so a sync fetches the latest 30 days only and
 *   a 429 is a "try later", never a repair.
 * - Pending: `hold: true`.
 * - Repair: 401/403 (token revoked).
 */

export const MONOBANK_API = 'https://api.monobank.ua';
// Monobank allows 31 days + 1 hour per statement; 30 whole days plus today stays inside it.
const MAX_WINDOW_DAYS = 30;
const NUMERIC_CURRENCY: Record<number, string> = {
  980: 'UAH',
  840: 'USD',
  978: 'EUR',
  826: 'GBP',
  985: 'PLN',
  203: 'CZK',
  756: 'CHF',
};

interface MonoAccount {
  id: string;
  balance: number;
  creditLimit?: number;
  type?: string;
  currencyCode: number;
  maskedPan?: string[];
  iban?: string;
}
interface MonoStatement {
  id: string;
  time: number;
  description: string;
  hold?: boolean;
  amount: number;
  operationAmount?: number;
  currencyCode?: number;
  counterName?: string;
  comment?: string;
}

function client(ctx: ConnectorContext): HttpClient {
  return new HttpClient(ctx, {
    provider: 'Monobank',
    baseUrl: MONOBANK_API,
    headers: { 'X-Token': connectionSecret(ctx, 'MONOBANK_TOKEN', 'Monobank') },
    retries: 0,
  });
}

export async function syncMonobank(
  ctx: ConnectorContext,
  connection: Connection,
): Promise<SyncResult> {
  const http = client(ctx);
  const now = ctx.now();
  const today = todayUtc(now);
  const since = readSince(connection);
  const oldest = addDays(today, -MAX_WINDOW_DAYS);
  const from = since && addDays(since, -7) > oldest ? addDays(since, -7) : oldest;
  const result = emptyResult();

  const info = await http.get<{ accounts: MonoAccount[] }>('/personal/client-info');
  if (!Array.isArray(info?.accounts)) throw new ProviderDataError('Monobank', 'client-info');

  for (const a of info.accounts) {
    const currency = NUMERIC_CURRENCY[a.currencyCode] ?? 'UAH';
    const credit = (a.creditLimit ?? 0) > 0;
    const type = a.type === 'fop' ? 'checking' : credit ? 'credit_card' : 'checking';
    result.accounts.push(
      providerAccount({
        externalId: a.id,
        name: `Monobank ${a.type ?? 'card'} ${currency}`,
        institutionName: 'monobank',
        type,
        currency,
        // Monobank: balance includes the credit line, so owed = limit - balance.
        balance: credit ? asMinor((a.creditLimit ?? 0) - a.balance) : asMinor(a.balance),
        creditLimit: credit ? asMinor(a.creditLimit) : null,
        mask: a.maskedPan?.[0] ? a.maskedPan[0].slice(-4) : null,
      }),
    );
    const toUnix = (d: string, end = false): number =>
      Math.floor(Date.parse(`${d}T${end ? '23:59:59' : '00:00:00'}Z`) / 1000);
    const rows = await http.get<MonoStatement[]>(
      `/personal/statement/${encodeURIComponent(a.id)}/${toUnix(from)}/${toUnix(today, true)}`,
    );
    if (!Array.isArray(rows)) throw new ProviderDataError('Monobank', 'statement');
    for (const r of rows) {
      const date = toLocalDate(r.time);
      if (!date) continue;
      const foreign =
        r.currencyCode !== undefined &&
        r.currencyCode !== a.currencyCode &&
        r.operationAmount !== undefined;
      result.transactions.push(
        providerTransaction({
          externalId: r.id,
          accountExternalId: a.id,
          date,
          amount: asMinor(r.amount),
          currency,
          originalAmount: foreign ? asMinor(r.operationAmount) : null,
          originalCurrency: foreign ? (NUMERIC_CURRENCY[r.currencyCode as number] ?? null) : null,
          rawName: r.description,
          merchantName: r.counterName ?? null,
          pending: r.hold === true,
        }),
      );
    }
  }
  result.nextCursor = sinceCursor(today);
  return result;
}

export const monobankAdapter = defineAdapter({
  id: 'monobank',
  sync: syncMonobank,
  probe: async (ctx) => {
    await client(ctx).get('/personal/client-info');
  },
});
