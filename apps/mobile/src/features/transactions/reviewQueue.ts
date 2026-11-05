import type { Transaction } from '@manaclaude/shared';
import type { Lookups } from '../../data/selectors';
import { activeLink, describeTransaction, isListed, type TransactionListRow } from './display';

/**
 * The review queue: unreviewed transactions, least certain first.
 *
 * Confidence is what the AI reported for the category. A transaction without a
 * category is the least certain thing there is (0). A category that came from
 * a rule, the bank or the user has no AI score and counts as certain (1). A
 * linked transfer is as certain as its match.
 */

export interface ReviewItem extends TransactionListRow {
  /** 0 to 1. */
  confidence: number;
  /** Skipped in this session: sorted after everything that was not skipped. */
  skipped: boolean;
}

export function reviewConfidence(txn: Transaction, lookups: Lookups): number {
  const link = activeLink(txn, lookups);
  if (link) return link.matchScore ?? 1;
  if (txn.aiCategoryConfidence !== null) return txn.aiCategoryConfidence;
  return txn.categoryId ? 1 : 0;
}

/** True for a transaction that belongs in the queue. */
export function needsReview(txn: Transaction, lookups: Lookups): boolean {
  return !txn.reviewed && !txn.isSplitParent && isListed(txn, lookups);
}

/**
 * Lowest confidence first; ties go to the newest, then to the id so the order
 * never jumps around. Skipped items follow, in the order they were skipped.
 */
export function buildReviewQueue(
  transactions: readonly Transaction[],
  lookups: Lookups,
  skippedIds: readonly string[] = [],
): ReviewItem[] {
  const skippedOrder = new Map(skippedIds.map((id, i) => [id, i]));
  const items: ReviewItem[] = [];
  for (const txn of transactions) {
    if (!needsReview(txn, lookups)) continue;
    items.push({
      ...describeTransaction(txn, lookups),
      confidence: reviewConfidence(txn, lookups),
      skipped: skippedOrder.has(txn.id),
    });
  }
  return items.sort((a, b) => {
    if (a.skipped !== b.skipped) return a.skipped ? 1 : -1;
    if (a.skipped && b.skipped) {
      return (skippedOrder.get(a.txn.id) ?? 0) - (skippedOrder.get(b.txn.id) ?? 0);
    }
    return (
      a.confidence - b.confidence ||
      b.txn.date.localeCompare(a.txn.date) ||
      a.txn.id.localeCompare(b.txn.id)
    );
  });
}

export function reviewCount(transactions: readonly Transaction[], lookups: Lookups): number {
  let n = 0;
  for (const t of transactions) if (needsReview(t, lookups)) n += 1;
  return n;
}

/** "AI 41%" text for a row: the score, or why there is none. */
export function confidenceLabel(item: Pick<ReviewItem, 'txn' | 'confidence' | 'transfer'>): string {
  if (item.transfer) return `Match ${Math.round(item.confidence * 100)}%`;
  if (item.txn.aiCategoryConfidence !== null) return `AI ${Math.round(item.confidence * 100)}%`;
  return item.txn.categoryId ? 'Set by you or a rule' : 'No category';
}

/** Below this the confidence shows in the warning colour. */
export const LOW_CONFIDENCE = 0.6;
