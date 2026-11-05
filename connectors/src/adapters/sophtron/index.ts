import type {
  AccountSubtype,
  AccountType,
  Connection,
  ConnectorContext,
  SyncResult,
} from '@manaclaude/shared';
import { addDays } from '@manaclaude/shared';
import { HttpClient } from '../../http';
import { readSince, sinceCursor } from '../../util/cursor';
import { todayUtc, toLocalDate, windowStart } from '../../util/dates';
import { toMinor } from '../../util/decimal';
import { fromBase64, hmac, toBase64 } from '../../util/crypto';
import {
  appSecret,
  connectionSecret,
  defineAdapter,
  emptyResult,
  optionalSecret,
  providerAccount,
  providerTransaction,
} from '../../kit';
import { ProviderDataError, repairNeeded } from '../../errors';

/**
 * Sophtron (https://sophtron.com), free for personal use.
 * Follows Sure: app/models/provider/sophtron.rb (request signing, endpoints,
 * job states), sophtron_item/importer.rb (refresh then fetch, 60-day overlap),
 * sophtron_account/processor.rb (balance signs) and sophtron_entry/processor.rb
 * (transaction signs).
 *
 * - Auth: every request carries
 *   `Authorization: FIApiAUTH:<userId>:<base64 HMAC-SHA256>:<authPath>`, where the
 *   HMAC key is the base64-decoded access key and the signed text is
 *   "<METHOD>\n<authPath>". authPath is "/" + the last path segment, lower case.
 * - Secrets: SOPHTRON_USER_ID and SOPHTRON_ACCESS_KEY (Worker secrets);
 *   SOPHTRON_USER_INSTITUTION_ID (the login this connection reads, saved when the
 *   user links the bank); SOPHTRON_CARD_BALANCE_SIGN ("debt" or "credit") only if
 *   a bank reports card balances the other way round.
 * - Signs: transactions arrive positive for money in, which is the model's rule.
 *   Card and loan balances arrive negative when owed, so they are negated to the
 *   model's "owed is positive" (Sure does the same unless told otherwise).
 * - Repair: a 401/403, or a refresh job that asks for a security answer, a text
 *   code or a captcha, means the user must go through Sophtron's sign-in again.
 */

export const SOPHTRON_API = 'https://api.sophtron.com/api';
const BACKFILL_DAYS = 365;
const OVERLAP_DAYS = 60;

type Raw = Record<string, unknown>;

function pick(obj: Raw, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

const str = (v: unknown): string | undefined =>
  v === undefined || v === null ? undefined : String(v);

/** "/Transaction/GetTransactionsByTransactionDate" becomes "/gettransactionsbytransactiondate". */
export function sophtronAuthPath(apiPath: string): string {
  const path = apiPath.split('?')[0] ?? '';
  const last = path.split('/').filter(Boolean).pop() ?? '';
  return `/${last}`.toLowerCase();
}

export async function sophtronAuthHeader(
  userId: string,
  accessKey: string,
  method: string,
  apiPath: string,
): Promise<string> {
  const authPath = sophtronAuthPath(apiPath);
  const signature = await hmac(
    'SHA-256',
    fromBase64(accessKey),
    `${method.toUpperCase()}\n${authPath}`,
  );
  return `FIApiAUTH:${userId}:${toBase64(signature)}:${authPath}`;
}

function arrayFrom(parsed: unknown, ...keys: string[]): Raw[] {
  if (Array.isArray(parsed)) return parsed as Raw[];
  if (parsed && typeof parsed === 'object') {
    for (const k of keys) {
      const v = (parsed as Raw)[k];
      if (Array.isArray(v)) return v as Raw[];
    }
    if (Object.keys(parsed).length === 0) return [];
  }
  if (parsed === undefined) return [];
  throw new ProviderDataError('Sophtron', 'list');
}

export function mapSophtronType(
  rawType: string | undefined,
  rawSub: string | undefined,
): { type: AccountType; subtype: AccountSubtype | null } {
  const t = `${rawType ?? ''} ${rawSub ?? ''}`.toLowerCase();
  if (/credit|card/.test(t)) return { type: 'credit_card', subtype: null };
  if (/mortgage/.test(t)) return { type: 'mortgage', subtype: null };
  if (/loan|line of credit|heloc/.test(t)) return { type: 'loan', subtype: null };
  if (/401|ira|retire|pension/.test(t)) return { type: 'retirement', subtype: null };
  if (/invest|brokerage|stock|securit/.test(t)) return { type: 'brokerage', subtype: null };
  if (/crypto|bitcoin/.test(t)) return { type: 'crypto', subtype: null };
  if (/saving/.test(t)) return { type: 'savings', subtype: null };
  if (/money market/.test(t)) return { type: 'savings', subtype: 'money_market' };
  return { type: 'checking', subtype: null };
}

/** Job answer that needs the person: security question, text code, captcha. */
export function sophtronJobNeedsInput(job: unknown): boolean {
  if (!job || typeof job !== 'object') return false;
  const j = job as Raw;
  const tokenNeeded =
    !pick(j, 'TokenInput', 'token_input') &&
    (j.TokenSentFlag === true ||
      Boolean(pick(j, 'TokenInputName', 'token_input_name')) ||
      pick(j, 'LastStep', 'last_step') === 'TokenInput');
  return Boolean(
    pick(j, 'SecurityQuestion', 'security_question') ||
    pick(j, 'TokenMethod', 'token_method') ||
    pick(j, 'TokenRead', 'token_read') ||
    pick(j, 'CaptchaImage', 'captcha_image') ||
    tokenNeeded,
  );
}

function client(ctx: ConnectorContext): HttpClient {
  const userId = appSecret(ctx, 'SOPHTRON_USER_ID', 'Sophtron');
  const accessKey = appSecret(ctx, 'SOPHTRON_ACCESS_KEY', 'Sophtron');
  return new HttpClient(ctx, {
    provider: 'Sophtron',
    baseUrl: SOPHTRON_API,
    sign: async ({ method, path }) => ({
      Authorization: await sophtronAuthHeader(userId, accessKey, method, path),
    }),
  });
}

export async function syncSophtron(
  ctx: ConnectorContext,
  connection: Connection,
): Promise<SyncResult> {
  const http = client(ctx);
  const userInstitutionId = connectionSecret(ctx, 'SOPHTRON_USER_INSTITUTION_ID', 'Sophtron');
  const cardSign = optionalSecret(ctx, 'SOPHTRON_CARD_BALANCE_SIGN');
  const today = todayUtc(ctx.now());
  const since = readSince(connection);
  const start = windowStart(today, since, {
    backfillDays: BACKFILL_DAYS,
    overlapDays: OVERLAP_DAYS,
  });
  const result = emptyResult();

  const accounts = arrayFrom(
    await http.post('/UserInstitution/GetUserInstitutionAccounts', {
      UserInstitutionID: userInstitutionId,
    }),
    'accounts',
    'Accounts',
  );

  for (const a of accounts) {
    const id = str(pick(a, 'AccountID', 'account_id', 'id'));
    const name = str(pick(a, 'AccountName', 'account_name', 'name'));
    if (!id || !name) continue;
    const status = (
      str(pick(a, 'AccountStatus', 'account_status', 'status')) ?? 'active'
    ).toLowerCase();
    if (/closed|inactive/.test(status)) continue;
    const currency = (
      str(pick(a, 'BalanceCurrency', 'balance_currency', 'Currency', 'currency')) ?? 'USD'
    ).toUpperCase();
    const { type, subtype } = mapSophtronType(
      str(pick(a, 'AccountType', 'account_type', 'type')),
      str(pick(a, 'AccountSubType', 'account_sub_type', 'SubType', 'sub_type')),
    );
    const observed = toMinor(
      str(pick(a, 'AccountBalance', 'account_balance', 'Balance', 'balance')) ?? 0,
      currency,
    );
    let balance = observed;
    if (type === 'credit_card') {
      balance =
        cardSign === 'credit'
          ? -Math.abs(observed)
          : cardSign === 'debt'
            ? Math.abs(observed)
            : -observed;
    } else if (type === 'loan' || type === 'mortgage') {
      balance = -observed;
    }
    const number = str(pick(a, 'AccountNumber', 'account_number'));
    result.accounts.push(
      providerAccount({
        externalId: id,
        name,
        institutionName: str(pick(a, 'InstitutionName', 'institution_name')) ?? null,
        type,
        subtype,
        currency,
        balance: balance || 0,
        mask: number ? number.slice(-4) : null,
      }),
    );

    // Ask Sophtron to pull fresh data first, except on the very first sync.
    if (since) {
      const job = await http.post('/UserInstitutionAccount/RefreshUserInstitutionAccount', {
        AccountID: id,
      });
      if (sophtronJobNeedsInput(job)) {
        throw repairNeeded('Sophtron', 'the bank asks for a security answer or code');
      }
    }

    const rows = arrayFrom(
      await http.post('/Transaction/GetTransactionsByTransactionDate', {
        AccountID: id,
        StartDate: start,
        EndDate: addDays(today, 1),
      }),
      'transactions',
      'Transactions',
    );
    for (const t of rows) {
      const txId = str(
        pick(t, 'TransactionID', 'TransactionId', 'transaction_id', 'transactionId', 'ID', 'id'),
      );
      const date = toLocalDate(str(pick(t, 'TransactionDate', 'transaction_date', 'Date', 'date')));
      if (!txId || !date) continue;
      const txCurrency = (str(pick(t, 'Currency', 'currency')) ?? currency).toUpperCase();
      const description = str(pick(t, 'Description', 'description')) ?? '';
      const merchant = str(pick(t, 'Merchant', 'merchant'))?.trim() || null;
      const status = (str(pick(t, 'Status', 'status')) ?? 'completed').toLowerCase();
      result.transactions.push(
        providerTransaction({
          externalId: txId,
          accountExternalId: id,
          date,
          // Sophtron: positive = money in, negative = money out.
          amount: toMinor(str(pick(t, 'Amount', 'amount')) ?? 0, txCurrency),
          currency: txCurrency,
          rawName: description || merchant || 'Unknown',
          merchantName: merchant,
          pending: status.includes('pend'),
        }),
      );
    }
  }
  result.nextCursor = sinceCursor(today);
  return result;
}

export const sophtronAdapter = defineAdapter({
  id: 'sophtron',
  sync: syncSophtron,
  probe: async (ctx) => {
    await client(ctx).request('GET', '/Institution/HealthCheckAuth', { text: true });
  },
});
