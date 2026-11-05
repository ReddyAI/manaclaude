import type { ConnectorContext } from '@manaclaude/shared';
import { HttpClient } from '../http';
import { appSecret } from '../kit';
import { ProviderDataError } from '../errors';
import { SOPHTRON_API, sophtronAuthHeader, sophtronJobNeedsInput } from '../adapters/sophtron';

/**
 * Linking a bank through Sophtron, following Sure (app/models/provider/
 * sophtron.rb and sophtron_items_controller.rb):
 *
 * 1. GetInstitutionByName finds the bank.
 * 2. CreateUserInstitution sends the bank user name and password once, with
 *    the app's own Sophtron user id. Sophtron answers with a JobID and the
 *    UserInstitutionID (the login this connection will read).
 * 3. GetJobInformationByID is polled until the job succeeds, fails, or asks
 *    for a security answer, a one-time code, a phone check or a captcha; the
 *    answer goes back through UpdateJobSecurityAnswer, UpdateJobTokenInput or
 *    UpdateJobCaptcha, and polling continues.
 *
 * The bank password is never stored: it goes to Sophtron in step 2 and
 * nowhere else. Only the UserInstitutionID is saved (encrypted) for syncing.
 */

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

/** For linking, a 401 means the app's Sophtron keys are wrong, not a login to repair. */
function client(ctx: ConnectorContext): HttpClient {
  const userId = appSecret(ctx, 'SOPHTRON_USER_ID', 'Sophtron');
  const accessKey = appSecret(ctx, 'SOPHTRON_ACCESS_KEY', 'Sophtron');
  return new HttpClient(ctx, {
    provider: 'Sophtron',
    baseUrl: SOPHTRON_API,
    repairStatuses: [],
    retries: 1,
    sign: async ({ method, path }) => ({
      Authorization: await sophtronAuthHeader(userId, accessKey, method, path),
    }),
  });
}

export interface SophtronInstitution {
  id: string;
  name: string;
  url: string | null;
}

export async function searchSophtronInstitutions(
  ctx: ConnectorContext,
  name: string,
): Promise<SophtronInstitution[]> {
  const resp = await client(ctx).post<unknown>('/Institution/GetInstitutionByName', {
    InstitutionName: name,
  });
  const list = Array.isArray(resp)
    ? (resp as Raw[])
    : resp && typeof resp === 'object'
      ? (((resp as Raw).institutions ?? (resp as Raw).Institutions ?? []) as Raw[])
      : [];
  const out: SophtronInstitution[] = [];
  for (const i of Array.isArray(list) ? list : []) {
    const id = str(pick(i, 'InstitutionID', 'institution_id', 'InstitutionId'));
    const nm = str(pick(i, 'InstitutionName', 'institution_name', 'Name'));
    if (id && nm) out.push({ id, name: nm, url: str(pick(i, 'URL', 'Url', 'url')) ?? null });
  }
  return out.slice(0, 30);
}

export async function createSophtronLogin(
  ctx: ConnectorContext,
  input: { institutionId: string; username: string; password: string; pin?: string },
): Promise<{ jobId: string; userInstitutionId: string }> {
  const resp = await client(ctx).post<Raw>('/UserInstitution/CreateUserInstitution', {
    UserID: appSecret(ctx, 'SOPHTRON_USER_ID', 'Sophtron'),
    InstitutionID: input.institutionId,
    UserName: input.username,
    Password: input.password,
    PIN: input.pin ?? '',
  });
  const jobId = resp ? str(pick(resp, 'JobID', 'job_id', 'JobId')) : undefined;
  const userInstitutionId = resp
    ? str(pick(resp, 'UserInstitutionID', 'user_institution_id', 'UserInstitutionId'))
    : undefined;
  if (!jobId || !userInstitutionId) throw new ProviderDataError('Sophtron', 'sign-in job');
  return { jobId, userInstitutionId };
}

export interface SophtronChallenge {
  securityQuestions: string[];
  tokenMethods: string[];
  /** A one-time code was sent; ask for it. */
  tokenSent: boolean;
  /** Text to read out (approve on your phone, call this number). */
  tokenRead: string | null;
  /** Base64 PNG of a captcha. */
  captchaImage: string | null;
}

export type SophtronJobView =
  | { state: 'pending' }
  | { state: 'success' }
  | { state: 'mfa'; challenge: SophtronChallenge }
  | { state: 'failed'; reason: string };

const FAILURE_STATUSES = ['completed', 'timeout', 'failed', 'failure', 'error'];

function jsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value !== 'string' || value.trim() === '') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [String(parsed)];
  } catch {
    return [value];
  }
}

/** Reads a Sophtron job the way Sure does: success, then input needed, then completed, then failed. */
export function readSophtronJob(job: unknown): SophtronJobView {
  if (!job || typeof job !== 'object') return { state: 'pending' };
  const j = job as Raw;
  const success = pick(j, 'SuccessFlag', 'success_flag');
  const last = (str(pick(j, 'LastStatus', 'last_status')) ?? '').trim();
  if (success === true || last.toLowerCase() === 'accountsready') return { state: 'success' };
  if (sophtronJobNeedsInput(j)) {
    const tokenSent =
      !pick(j, 'TokenInput', 'token_input') &&
      (j.TokenSentFlag === true ||
        Boolean(pick(j, 'TokenInputName', 'token_input_name')) ||
        pick(j, 'LastStep', 'last_step') === 'TokenInput');
    const captcha = str(pick(j, 'CaptchaImage', 'captcha_image'));
    return {
      state: 'mfa',
      challenge: {
        securityQuestions: jsonArray(pick(j, 'SecurityQuestion', 'security_question')).slice(0, 10),
        tokenMethods: jsonArray(pick(j, 'TokenMethod', 'token_method')).slice(0, 10),
        tokenSent,
        tokenRead: str(pick(j, 'TokenRead', 'token_read')) ?? null,
        // Only base64 characters: the app shows it as a data: image.
        captchaImage: captcha ? (/^[A-Za-z0-9+/=\s]+/.exec(captcha)?.[0] ?? null) : null,
      },
    };
  }
  const failedStatus =
    FAILURE_STATUSES.includes(last.toLowerCase()) || /timeout|fail|error/i.test(last);
  if (last.toLowerCase() === 'completed' && !(success === false && failedStatus)) {
    return { state: 'success' };
  }
  if (success === false && failedStatus) {
    return {
      state: 'failed',
      reason: /timeout/i.test(last)
        ? 'The bank took too long to answer. Try again in a few minutes.'
        : 'The bank did not accept the sign-in. Check the user name and password and try again.',
    };
  }
  return { state: 'pending' };
}

export async function getSophtronJob(
  ctx: ConnectorContext,
  jobId: string,
): Promise<SophtronJobView> {
  return readSophtronJob(
    await client(ctx).post<unknown>('/Job/GetJobInformationByID', { JobID: jobId }),
  );
}

export type SophtronAnswer =
  | { type: 'security_answer'; answers: string[] }
  | { type: 'token_choice'; choice: string }
  | { type: 'token_input'; code: string }
  | { type: 'verify_phone' }
  | { type: 'captcha'; text: string };

export async function answerSophtronJob(
  ctx: ConnectorContext,
  jobId: string,
  answer: SophtronAnswer,
): Promise<void> {
  const http = client(ctx);
  switch (answer.type) {
    case 'security_answer':
      await http.post('/Job/UpdateJobSecurityAnswer', {
        JobID: jobId,
        SecurityAnswer: JSON.stringify(answer.answers),
      });
      return;
    case 'token_choice':
      await http.post('/Job/UpdateJobTokenInput', {
        JobID: jobId,
        TokenChoice: answer.choice,
        TokenInput: null,
        VerifyPhoneFlag: null,
      });
      return;
    case 'token_input':
      await http.post('/Job/UpdateJobTokenInput', {
        JobID: jobId,
        TokenChoice: null,
        TokenInput: answer.code,
        VerifyPhoneFlag: null,
      });
      return;
    case 'verify_phone':
      await http.post('/Job/UpdateJobTokenInput', {
        JobID: jobId,
        TokenChoice: null,
        TokenInput: null,
        VerifyPhoneFlag: true,
      });
      return;
    case 'captcha':
      await http.post('/Job/UpdateJobCaptcha', { JobID: jobId, CaptchaInput: answer.text });
      return;
  }
}

/**
 * Repair without the password: ask Sophtron to refresh one account of the
 * existing login, which makes the bank ask its question again (the job then
 * runs through the same poll and answer steps). The login and its account ids
 * stay as they are. Returns null when Sophtron refreshed with no job to follow.
 */
export async function startSophtronRefresh(
  ctx: ConnectorContext,
  userInstitutionId: string,
): Promise<{ jobId: string } | null> {
  const http = client(ctx);
  const resp = await http.post<unknown>('/UserInstitution/GetUserInstitutionAccounts', {
    UserInstitutionID: userInstitutionId,
  });
  const list = Array.isArray(resp)
    ? (resp as Raw[])
    : (((resp as Raw | undefined)?.Accounts ?? (resp as Raw | undefined)?.accounts ?? []) as Raw[]);
  const account = (Array.isArray(list) ? list : []).find(
    (a) => !/closed|inactive/i.test(str(pick(a, 'AccountStatus', 'account_status')) ?? ''),
  );
  const accountId = account ? str(pick(account, 'AccountID', 'account_id', 'id')) : undefined;
  if (!accountId) throw new ProviderDataError('Sophtron', 'accounts');
  const job = await http.post<Raw>('/UserInstitutionAccount/RefreshUserInstitutionAccount', {
    AccountID: accountId,
  });
  const jobId = job ? str(pick(job, 'JobID', 'job_id', 'JobId')) : undefined;
  return jobId ? { jobId } : null;
}
