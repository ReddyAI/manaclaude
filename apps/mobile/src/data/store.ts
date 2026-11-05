import { useMemo, useSyncExternalStore } from 'react';
import type { FinanceDataset } from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';

/**
 * The app's data store: one FinanceDataset, sample data for now. When the
 * backend exists, a sync step replaces it with the user's data in the same shape.
 *
 * Feature folders write their own actions with `updateFinance` (for example
 * features/transactions/actions.ts), so nobody needs to edit this file to add one.
 */

type Listener = () => void;

let state: FinanceDataset = createSampleData();
const listeners = new Set<Listener>();

export function getFinance(): FinanceDataset {
  return state;
}

/** Replace the dataset with a new one built from the old. Never mutate `prev`. */
export function updateFinance(recipe: (prev: FinanceDataset) => FinanceDataset): void {
  const next = recipe(state);
  if (next === state) return;
  state = next;
  for (const l of listeners) l();
}

/** Swap in a whole dataset (tests, a fresh sync). */
export function setFinance(next: FinanceDataset): void {
  updateFinance(() => next);
}

export function subscribeFinance(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The whole dataset; re-renders when it changes. */
export function useFinance(): FinanceDataset {
  return useSyncExternalStore(subscribeFinance, getFinance, getFinance);
}

/**
 * Derived data, recomputed only when the dataset or `dep` changes.
 * `useFinanceSelector((d) => d.accounts.filter(...))`
 * `useFinanceSelector((d, policies) => buildLookups(d, policies), moneyPolicies)`
 */
export function useFinanceSelector<T, D = undefined>(
  selector: (data: FinanceDataset, dep: D) => T,
  dep?: D,
): T {
  const data = useFinance();
  // The selector is usually an inline function; only the data and `dep` decide when to recompute.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => selector(data, dep as D), [data, dep]);
}
