import type { Connection, ConnectorContext, SyncResult } from '@manaclaude/shared';
import { addDays } from '@manaclaude/shared';
import { HttpClient } from '../../http';
import { readSince, sinceCursor } from '../../util/cursor';
import { todayUtc, toLocalDate } from '../../util/dates';
import { toMinor } from '../../util/decimal';
import {
  connectionSecret,
  defineAdapter,
  emptyResult,
  providerAccount,
  providerTransaction,
} from '../../kit';
import { ProviderDataError, repairNeeded } from '../../errors';

/**
 * Fio banka (Czech Republic), https://www.fio.cz/docs/cz/API_Bankovnictvi.pdf,
 * read-only token created in internet banking.
 * Follows Sure: app/models/provider/fio.rb and fio_entry/processor.rb.
 *
 * - Secrets: FIO_TOKEN (per login). The token is part of the URL path.
 * - Signs: column1 is negative for money out, the model's rule.
 * - Limits: one request per 30 seconds per token (HTTP 409 means "too soon",
 *   not a repair) and a token can be revoked (HTTP 500/422 on an invalid token).
 * - Transactions have a unique "ID pohybu" (column22), which is the provider id.
 * - Fio posts only settled transactions, so nothing is pending.
 */

export const FIO_API = 'https://fioapi.fio.cz/v1/rest';
const BACKFILL_DAYS = 90;
const OVERLAP_DAYS = 7;

type Column = { value: string | number | null; name?: string } | null | undefined;
interface FioTransaction {
  column0?: Column; // date
  column1?: Column; // amount
  column14?: Column; // currency
  column10?: Column; // counterparty name
  column7?: Column; // user identification
  column8?: Column; // type
  column16?: Column; // message for the recipient
  column22?: Column; // id of the movement
  column25?: Column; // comment
}
interface FioResponse {
  accountStatement: {
    info: {
      accountId: string;
      bankId: string;
      currency: string;
      closingBalance: number;
      iban?: string;
    };
    transactionList?: { transaction?: FioTransaction[] } | null;
  };
}

const text = (c: Column): string | null =>
  c && c.value !== null && c.value !== undefined ? String(c.value) : null;

function client(ctx: ConnectorContext): HttpClient {
  return new HttpClient(ctx, {
    provider: 'Fio banka',
    baseUrl: FIO_API,
    repairStatuses: [401, 403, 422, 500],
    retries: 0,
  });
}

export async function syncFio(ctx: ConnectorContext, connection: Connection): Promise<SyncResult> {
  const token = connectionSecret(ctx, 'FIO_TOKEN', 'Fio banka');
  const http = client(ctx);
  const today = todayUtc(ctx.now());
  const since = readSince(connection);
  const from = since ? addDays(since, -OVERLAP_DAYS) : addDays(today, -BACKFILL_DAYS);

  const resp = await http.get<FioResponse>(
    `/periods/${encodeURIComponent(token)}/${from}/${today}/transactions.json`,
  );
  const info = resp?.accountStatement?.info;
  if (!info) throw new ProviderDataError('Fio banka', 'statement');
  if (!info.accountId) throw repairNeeded('Fio banka', 'the token did not return an account');

  const currency = info.currency.toUpperCase();
  const accountId = `${info.accountId}/${info.bankId}`;
  const result = emptyResult();
  result.accounts.push(
    providerAccount({
      externalId: accountId,
      name: `Fio ${currency} account`,
      institutionName: 'Fio banka',
      type: 'checking',
      currency,
      balance: toMinor(info.closingBalance, currency),
      mask: info.accountId.slice(-4),
    }),
  );
  for (const t of resp.accountStatement.transactionList?.transaction ?? []) {
    const id = text(t.column22);
    const date = toLocalDate(text(t.column0));
    const amount = text(t.column1);
    if (!id || !date || amount === null) continue;
    const counterparty = text(t.column10);
    result.transactions.push(
      providerTransaction({
        externalId: id,
        accountExternalId: accountId,
        date,
        // Fio: negative = money out.
        amount: toMinor(amount, text(t.column14) ?? currency),
        currency: (text(t.column14) ?? currency).toUpperCase(),
        rawName:
          [counterparty, text(t.column16) ?? text(t.column7) ?? text(t.column8)]
            .filter(Boolean)
            .join(' - ') || 'Fio transaction',
        merchantName: counterparty,
      }),
    );
  }
  result.nextCursor = sinceCursor(today);
  return result;
}

export const fioAdapter = defineAdapter({
  id: 'fio',
  sync: syncFio,
  probe: async (ctx) => {
    const token = connectionSecret(ctx, 'FIO_TOKEN', 'Fio banka');
    const today = todayUtc(ctx.now());
    await client(ctx).get(
      `/periods/${encodeURIComponent(token)}/${today}/${today}/transactions.json`,
    );
  },
});
