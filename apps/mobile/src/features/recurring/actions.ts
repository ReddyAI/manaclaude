import type { Id, SubscriptionDecision } from '@manaclaude/shared';
import { updateFinance } from '../../data/store';

/** Recurring edits (session C). Local store now; the backend call comes later. */

export function setDecision(id: Id, decision: SubscriptionDecision | null): void {
  updateFinance((d) => ({
    ...d,
    recurring: d.recurring.map((r) => (r.id === id ? { ...r, decision } : r)),
  }));
}

/** Mark a subscription as cancelled (or bring it back). Cancelled items leave the upcoming list. */
export function setRecurringStatus(id: Id, status: 'active' | 'paused' | 'cancelled'): void {
  updateFinance((d) => ({
    ...d,
    recurring: d.recurring.map((r) =>
      r.id === id ? { ...r, status, decision: status === 'cancelled' ? 'cancel' : r.decision } : r,
    ),
  }));
}
