import type {
  AccountSubtype,
  AccountType,
  Connection,
  ConnectorContext,
  SyncResult,
} from '@manaclaude/shared';
import { addDays } from '@manaclaude/shared';
import { HttpClient } from '../../http';
import { encodeCursor, parseCursor, readSince, sinceCursor } from '../../util/cursor';
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
 *   a bank reports card balances the other way round; SOPHTRON_LIABILITY_SIGNS
 *   ("customer" or "bank") to stop the guess below for cards and loans.
 * - Signs: checking and savings rows arrive positive for money in, the model's
 *   rule. Cards and loans are not consistent across banks (Sure issues 3252 and
 *   4350): some report them as the customer sees them (a purchase is negative,
 *   the owed balance negative), others as the bank's ledger (a purchase is
 *   positive, the owed balance positive). Sure always negates card and loan
 *   balances and always negates transaction amounts, which turns purchases into
 *   income for the second kind. This adapter decides per account with
 *   liabilitySignView(): the override, then Debit/Credit types, then a payment
 *   row's sign, then which sign most rows have. The answer is kept in the cursor
 *   so a quiet month with no rows keeps the last answer. With no evidence at all
 *   the balance is taken as owed (absolute value).
 * - Repair: a 401/403, or a refresh job that asks for a security answer, a text
 *   code or a captcha, means the user must go through Sophtron's sign-in again.
 */

export const SOPHTRON_API = 'https://api.sophtron.com/api';
/** Ask for two years on the first sync; banks return what they have (often less). */
const BACKFILL_DAYS = 730;
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

/** How a bank reports a card or loan: as the customer sees it, or as its own ledger. */
export type LiabilitySignView = 'customer' | 'bank';

const PAYMENT_TEXT = /\b(payment|pymt|autopay|auto pay|thank you)\b/i;

/**
 * Decide how one card or loan account reports its signs (see the header).
 * `rows` are the raw provider amounts (major units) with their type and text.
 * Returns null when the rows give no answer.
 */
export function liabilitySignView(
  accountType: 'credit_card' | 'loan' | 'mortgage',
  rows: readonly { amount: number; type?: string | undefined; text: string }[],
): LiabilitySignView | null {
  const nonZero = rows.filter((r) => r.amount !== 0 && Number.isFinite(r.amount));
  if (nonZero.length === 0) return null;
  // 1. Debit/Credit types: a debit is a purchase (cards) or interest (loans); it takes money from the customer.
  let debitPositive = 0;
  let debitNegative = 0;
  for (const r of nonZero) {
    const t = (r.type ?? '').toLowerCase();
    if (t !== 'debit' && t !== 'credit') continue;
    const positive = r.amount > 0;
    if ((t === 'debit') === positive) debitPositive += 1;
    else debitNegative += 1;
  }
  if (debitPositive !== debitNegative) return debitPositive > debitNegative ? 'bank' : 'customer';
  // 2. A payment row: money arriving on the card or loan, positive as the customer sees it.
  const payments = nonZero.filter((r) => PAYMENT_TEXT.test(r.text));
  if (payments.length > 0) {
    const positive = payments.filter((r) => r.amount > 0).length;
    if (positive * 2 !== payments.length)
      return positive * 2 > payments.length ? 'customer' : 'bank';
  }
  // 3. Most rows: purchases outnumber payments on a card; payments outnumber charges on a loan.
  const positive = nonZero.filter((r) => r.amount > 0).length;
  const negative = nonZero.length - positive;
  if (positive === negative) return null;
  if (accountType === 'credit_card') return positive > negative ? 'bank' : 'customer';
  return negative > positive ? 'bank' : 'customer';
}

interface SophtronCursor {
  since?: string;
  /** Last decided sign view per card or loan account id. */
  liabilitySigns?: Record<string, LiabilitySignView>;
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
  const forcedView = optionalSecret(ctx, 'SOPHTRON_LIABILITY_SIGNS');
  const today = todayUtc(ctx.now());
  const since = readSince(connection);
  const saved = parseCursor<SophtronCursor>(connection.syncCursor);
  const knownViews: Record<string, LiabilitySignView> = { ...(saved?.liabilitySigns ?? {}) };
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

    const liability = type === 'credit_card' || type === 'loan' || type === 'mortgage';
    let view: LiabilitySignView | null = null;
    if (liability) {
      view =
        forcedView === 'customer' || forcedView === 'bank'
          ? forcedView
          : (liabilitySignView(
              type,
              rows.map((t) => ({
                amount: Number(str(pick(t, 'Amount', 'amount')) ?? 0),
                type: str(pick(t, 'Type', 'type', 'TransactionType', 'transaction_type')),
                text: `${str(pick(t, 'Description', 'description')) ?? ''} ${str(pick(t, 'Merchant', 'merchant')) ?? ''}`,
              })),
            ) ??
            knownViews[id] ??
            null);
      if (view) knownViews[id] = view;
    }

    let balance = observed;
    if (type === 'credit_card' && (cardSign === 'credit' || cardSign === 'debt')) {
      balance = cardSign === 'credit' ? -Math.abs(observed) : Math.abs(observed);
    } else if (liability) {
      // Owed is positive in the model.
      balance = view === 'bank' ? observed : view === 'customer' ? -observed : Math.abs(observed);
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

    // The bank's ledger counts a purchase as positive; the model counts money leaving as negative.
    const flip = liability && view === 'bank';
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
      const raw = toMinor(str(pick(t, 'Amount', 'amount')) ?? 0, txCurrency);
      result.transactions.push(
        providerTransaction({
          externalId: txId,
          accountExternalId: id,
          date,
          // Checking and savings: positive = money in. Cards and loans: see liabilitySignView().
          amount: flip ? -raw || 0 : raw,
          currency: txCurrency,
          rawName: description || merchant || 'Unknown',
          merchantName: merchant,
          pending: status.includes('pend'),
        }),
      );
    }
  }
  result.nextCursor =
    Object.keys(knownViews).length > 0
      ? encodeCursor({ since: today, liabilitySigns: knownViews } satisfies SophtronCursor)
      : sinceCursor(today);
  return result;
}

export const sophtronAdapter = defineAdapter({
  id: 'sophtron',
  sync: syncSophtron,
  probe: async (ctx) => {
    await client(ctx).request('GET', '/Institution/HealthCheckAuth', { text: true });
  },
});
