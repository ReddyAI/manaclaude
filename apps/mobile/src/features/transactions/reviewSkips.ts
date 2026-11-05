import { useSyncExternalStore } from 'react';

/**
 * Transactions skipped in the review queue during this session. A skip is not
 * a decision: the transaction stays unreviewed and moves to the end of the
 * queue. Nothing is saved; the next launch starts fresh.
 */

type Listener = () => void;

let skipped: readonly string[] = [];
const listeners = new Set<Listener>();

function emit(next: readonly string[]): void {
  skipped = next;
  for (const l of listeners) l();
}

export function getSkipped(): readonly string[] {
  return skipped;
}

export function skipReview(transactionId: string): void {
  emit([...skipped.filter((id) => id !== transactionId), transactionId]);
}

export function clearSkips(): void {
  if (skipped.length > 0) emit([]);
}

export function useSkippedReviews(): readonly string[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getSkipped,
    getSkipped,
  );
}
