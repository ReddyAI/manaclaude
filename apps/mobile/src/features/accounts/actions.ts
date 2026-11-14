import type {
  Account,
  AccountDeleteRequest,
  AccountDeleteResponse,
  AccountDeletionPreview,
  AccountDetailResponse,
  AccountPatchRequest,
  AccountResponse,
  CreateCashAccountRequest,
} from '@manaclaude/shared';
import { api } from '../../data/backend/client';
import { canSaveToBackend, scheduleRefresh } from '../../data/backend/sync';
import { updateFinance } from '../../data/store';

/**
 * POST /v1/accounts/cash. Made on the Worker first, so the account has the
 * Worker's id; then put into the app's data (never into sample data) and the
 * data is loaded again. The route has no retry key: an answer that never
 * arrives may still have made the account.
 */
export async function createCashAccount(body: CreateCashAccountRequest): Promise<Account> {
  const { account } = await api<AccountResponse>('POST', '/v1/accounts/cash', body);
  if (canSaveToBackend()) {
    updateFinance((d) =>
      d.accounts.some((a) => a.id === account.id)
        ? d
        : { ...d, accounts: [...d.accounts, account] },
    );
    scheduleRefresh();
  }
  return account;
}

// Account editing and removal (PATCH and DELETE /v1/accounts/:id) ------------
//
// Nothing here changes the screen before the Worker answers. The Worker's
// account replaces the app's copy; the app's data is then loaded again, since
// balance readings and net worth history may have changed with it.

const accountPath = (id: string) => `/v1/accounts/${encodeURIComponent(id)}`;

export function getAccountDetail(id: string): Promise<AccountDetailResponse> {
  return api<AccountDetailResponse>('GET', accountPath(id));
}

export function patchAccount(
  id: string,
  body: AccountPatchRequest,
): Promise<AccountDetailResponse> {
  return api<AccountDetailResponse>('PATCH', accountPath(id), body);
}

export function getDeletionPreview(id: string): Promise<AccountDeletionPreview> {
  return api<AccountDeletionPreview>('GET', `${accountPath(id)}/deletion-preview`);
}

export function deleteAccountOnWorker(
  id: string,
  previewToken: string,
): Promise<AccountDeleteResponse> {
  const body: AccountDeleteRequest = { previewToken };
  return api<AccountDeleteResponse>('DELETE', accountPath(id), body);
}

/** Puts the Worker's copy of an account into the app's data (never into sample data). */
export function putAccountInData(account: Account, opts: { reload?: boolean } = {}): void {
  if (!canSaveToBackend()) return;
  updateFinance((d) =>
    d.accounts.some((a) => a.id === account.id)
      ? { ...d, accounts: d.accounts.map((a) => (a.id === account.id ? account : a)) }
      : d,
  );
  if (opts.reload) scheduleRefresh();
}

/**
 * The Worker removed the account: take it and its balance readings out of
 * the app's data, mark the cash account that now takes quick entries, and
 * load the data again.
 */
export function removeAccountFromData(
  id: string,
  defaultCash: AccountDeleteResponse['defaultCash'] | undefined,
): void {
  if (!canSaveToBackend()) return;
  updateFinance((d) => ({
    ...d,
    accounts: d.accounts
      .filter((a) => a.id !== id)
      .map((a) =>
        defaultCash?.wasDefault && a.id === defaultCash.nextAccountId
          ? { ...a, isDefaultCash: true }
          : a,
      ),
    balanceHistory: d.balanceHistory.filter((s) => s.accountId !== id),
  }));
  scheduleRefresh();
}
