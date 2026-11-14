import {
  formatMoney,
  type Account,
  type FinanceDataset,
  type Transaction,
} from '@manaclaude/shared';
import { isBalanceUnknown } from '../../data/manualBalance';

/**
 * Deleting a hand-entered cash entry (DELETE /v1/transactions/:id). The
 * Worker takes back what the quick entry did to the cash balance and reports
 * it as `reversedBalanceAmount`. Only an entry typed in by hand on a cash
 * account with no connection qualifies: not imported, not from a provider,
 * not an automatic ATM deposit, not split and not part of a transfer
 * (a rejected suggestion does not count).
 */

export type CashDeleteCheck =
  /** Offer "Delete". */
  | { offer: true }
  /** A cash entry that could be deleted once something is undone first. */
  | { offer: false; todo: string }
  /** Not a hand-entered cash entry: say nothing. */
  | { offer: false; todo: null };

export function cashDeleteCheck(
  txn: Transaction,
  data: Pick<FinanceDataset, 'accounts' | 'transferLinks'>,
): CashDeleteCheck {
  const account = data.accounts.find((a) => a.id === txn.accountId);
  const handEntered =
    !!account &&
    account.type === 'cash' &&
    account.connectionId === null &&
    account.externalId === null &&
    txn.source === 'manual' &&
    txn.connectionId === null &&
    txn.externalId === null &&
    txn.pendingExternalId === null &&
    txn.importId === null &&
    txn.importFingerprint === null;
  if (!handEntered) return { offer: false, todo: null };
  if (txn.isSplitParent || txn.splitParentId)
    return {
      offer: false,
      todo: 'To delete this cash entry, undo its split first.',
    };
  const linked =
    txn.transferLinkId !== null ||
    data.transferLinks.some(
      (l) =>
        l.status !== 'rejected' && (l.outTransactionId === txn.id || l.inTransactionId === txn.id),
    );
  if (linked)
    return {
      offer: false,
      todo: 'To delete this cash entry, unlink the transfer or turn down the suggested one first.',
    };
  return { offer: true };
}

/** How the cash balance moved, from the Worker's answer. */
export function reversedText(reversed: number, account: Account): string {
  if (isBalanceUnknown(account))
    return 'The cash balance is unknown, so it stays unknown and did not move.';
  if (reversed === 0)
    return 'The cash balance did not move, because a balance was entered by hand after this entry was added.';
  const by = formatMoney(Math.abs(reversed), account.currency);
  const now = formatMoney(account.balance, account.currency);
  // reversedBalanceAmount is what was subtracted: taking back money out (negative) raises the balance.
  return reversed < 0
    ? `The cash balance went back up by ${by}, to ${now}.`
    : `The cash balance went down by ${by}, to ${now}.`;
}

/** The Worker's refusals in plain words. */
export function cashDeleteErrorText(code: string): string | null {
  switch (code) {
    case 'cash_delete_refused':
      return 'Your Worker can only delete a cash entry typed in by hand that is not split and not part of a transfer. Undo the split or unlink the transfer first. Nothing was deleted.';
    case 'cash_balance_unknown':
      return "This entry's amount was edited before your Worker kept a record of what each entry did to the cash balance, so it cannot tell how much to take back. Enter the cash account's balance first (Accounts, the cash account, Edit; known or unknown), then delete again. Nothing was deleted.";
    case 'cash_balance_overflow':
      return 'Taking this entry back would make the cash balance too large to store. Nothing was deleted.';
    case 'account_changed':
      return 'The cash account or this entry changed while deleting, so nothing was deleted. Your data is being loaded again; look at the entry and try again.';
    default:
      return null;
  }
}

/**
 * The Worker deleted the entry: take it out of the app's data, use the
 * Worker's cash account, and leave its receipts waiting for a transaction
 * (as the Worker does: matchedTransactionId null, status needs_review).
 */
export function applyCashDelete(
  data: FinanceDataset,
  transactionId: string,
  account: Account | null,
  now: string,
): FinanceDataset {
  return {
    ...data,
    transactions: data.transactions.filter((t) => t.id !== transactionId),
    accounts: account
      ? data.accounts.map((a) => (a.id === account.id ? account : a))
      : data.accounts,
    transferLinks: data.transferLinks.filter(
      (l) => l.outTransactionId !== transactionId && l.inTransactionId !== transactionId,
    ),
    receipts: data.receipts.map((r) =>
      r.matchedTransactionId === transactionId
        ? { ...r, matchedTransactionId: null, status: 'needs_review', updatedAt: now }
        : r,
    ),
  };
}
