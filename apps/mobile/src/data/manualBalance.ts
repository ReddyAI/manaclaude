import type { Account, AccountWithManualBalance, ManualBalanceInfo } from '@manaclaude/shared';

/**
 * Accounts made by hand through POST /v1/accounts/manual carry where their
 * balance came from. The backend sends it on the account objects of the
 * dataset; the shared `Account` model does not list it, so read it here.
 */
export function manualBalanceOf(account: Account): ManualBalanceInfo | undefined {
  return (account as AccountWithManualBalance).manualBalance;
}

/**
 * True when nobody has said what this account's balance is. Its `balance`
 * is then a placeholder 0 and must be shown as unknown, never as zero.
 * Accounts without the information (linked, cash, older ones) are not unknown.
 */
export function isBalanceUnknown(account: Account): boolean {
  return manualBalanceOf(account)?.currentKnown === false;
}
