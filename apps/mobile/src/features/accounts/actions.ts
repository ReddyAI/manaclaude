import type { Account, AccountResponse, CreateCashAccountRequest } from '@manaclaude/shared';
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
