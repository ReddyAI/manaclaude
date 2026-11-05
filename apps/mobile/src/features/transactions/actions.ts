import { updateFinance } from '../../data/store';

/**
 * Transaction edits (session A owns this file). They change the local store
 * now; once the backend exists they also call its API.
 */

export function setReviewed(transactionId: string, reviewed: boolean): void {
  const now = new Date().toISOString();
  updateFinance((d) => ({
    ...d,
    transactions: d.transactions.map((t) =>
      t.id === transactionId
        ? { ...t, reviewed, reviewedAt: reviewed ? now : null, updatedAt: now }
        : t,
    ),
  }));
}
