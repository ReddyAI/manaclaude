import type { FinanceDataset, Receipt, Transaction } from '@manaclaude/shared';
import { daysBetween } from '@manaclaude/shared';

/**
 * Receipts waiting for a transaction: ones with none, and ones the Worker
 * marked "needs review" (its match was not clear, or the cash entry it
 * belonged to was deleted). Read from the dataset; a photo still on its way
 * up from this device (a placeholder key) is left out until the Worker has it.
 */

export const PENDING_UPLOAD_PREFIX = 'pending-upload/';

export function isOnWorker(receipt: Receipt): boolean {
  return !receipt.r2Key.startsWith(PENDING_UPLOAD_PREFIX);
}

export function receiptsToAttach(data: Pick<FinanceDataset, 'receipts'>): Receipt[] {
  return data.receipts
    .filter(
      (r) => isOnWorker(r) && (r.matchedTransactionId === null || r.status === 'needs_review'),
    )
    .sort((a, b) =>
      a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? 1 : -1,
    );
}

/** Plain words for why a receipt is in the list. */
export function waitingReason(receipt: Receipt): string {
  if (receipt.matchedTransactionId !== null)
    return 'Attached, but your Worker was not sure it is the right transaction.';
  if (receipt.status === 'failed') return 'Could not be read, and has no transaction.';
  if (receipt.status === 'needs_review')
    return 'Has no transaction. Its old one was deleted, or the match was not clear.';
  return 'Has no transaction yet.';
}

/**
 * Transactions a receipt can be attached to: money out, not a linked
 * transfer, not split, and without a receipt of its own (the Worker would
 * drop the other receipt's link). The one it is attached to now first (to
 * confirm a match the Worker was unsure of), then the same amount, then the
 * fewest days apart; a search narrows by name.
 */
export function attachCandidates(
  receipt: Receipt,
  transactions: readonly Transaction[],
  query: string,
  limit = 25,
): Transaction[] {
  const q = query.trim().toLowerCase();
  const total = receipt.total;
  const sameAmount = (t: Transaction) =>
    total !== null && (receipt.currency ?? t.currency) === t.currency && -t.amount === total;
  const days = (t: Transaction) =>
    receipt.date ? Math.abs(daysBetween(receipt.date, t.date)) : Number.MAX_SAFE_INTEGER;
  return transactions
    .filter(
      (t) =>
        t.amount < 0 &&
        (!t.receiptId || t.receiptId === receipt.id) &&
        !t.isSplitParent &&
        !t.splitParentId &&
        !t.transferLinkId &&
        (!q || t.name.toLowerCase().includes(q) || t.rawName.toLowerCase().includes(q)),
    )
    .map((t) => ({
      t,
      // The transaction it is attached to now (for a match to check) comes first.
      current: t.id === receipt.matchedTransactionId ? 0 : 1,
      same: sameAmount(t) ? 0 : 1,
      days: days(t),
    }))
    .sort(
      (a, b) =>
        a.current - b.current ||
        a.same - b.same ||
        a.days - b.days ||
        (a.t.date < b.t.date ? 1 : -1),
    )
    .slice(0, limit)
    .map((x) => x.t);
}
