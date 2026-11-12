import type { FinanceDataset } from '@manaclaude/shared';

/**
 * The last loaded dataset in the browser's storage (skipped quietly when it
 * is too big). Like the phone's copy, it records which backend it came from
 * and is only shown for that one.
 */
const KEY = 'billionaire.dataset.v1';

export interface CachedDataset {
  data: FinanceDataset;
  savedAt: string;
}

export async function readCachedDataset(scope: string): Promise<CachedDataset | null> {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Partial<CachedDataset> & { scope?: string };
    if (!scope || saved.scope !== scope || !saved.data || !saved.savedAt) return null;
    return { data: saved.data, savedAt: saved.savedAt };
  } catch {
    return null;
  }
}

/** Saves the copy for one backend; `data: null` deletes whatever copy is there. */
export async function writeCachedDataset(
  data: FinanceDataset | null,
  savedAt: string,
  scope: string,
): Promise<void> {
  try {
    if (!data) globalThis.localStorage?.removeItem(KEY);
    else globalThis.localStorage?.setItem(KEY, JSON.stringify({ scope, data, savedAt }));
  } catch {
    // Over the browser's storage quota: the app still works, it just loads fresh next time.
  }
}
