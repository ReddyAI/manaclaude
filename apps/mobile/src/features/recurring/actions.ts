import type { Id, SubscriptionDecision } from '@manaclaude/shared';
import { api } from '../../data/backend/client';
import { persist } from '../../data/backend/sync';
import { getFinance, updateFinance } from '../../data/store';

/** Recurring edits (session C). Local store at once; saved through /v1/recurring (session E2). */

export function setDecision(id: Id, decision: SubscriptionDecision | null): void {
  const before = getFinance();
  updateFinance((d) => ({
    ...d,
    recurring: d.recurring.map((r) => (r.id === id ? { ...r, decision } : r)),
  }));
  void persist('subscription', before, () => api('PATCH', `/v1/recurring/${id}`, { decision }));
}

/** Mark a subscription as cancelled (or bring it back). Cancelled items leave the upcoming list. */
export function setRecurringStatus(id: Id, status: 'active' | 'paused' | 'cancelled'): void {
  const before = getFinance();
  updateFinance((d) => ({
    ...d,
    recurring: d.recurring.map((r) =>
      r.id === id ? { ...r, status, decision: status === 'cancelled' ? 'cancel' : r.decision } : r,
    ),
  }));
  void persist('subscription', before, () => api('PATCH', `/v1/recurring/${id}`, { status }));
}
