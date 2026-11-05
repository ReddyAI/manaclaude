import type { FinanceDataset } from '@manaclaude/shared';

/** The last loaded dataset in the browser's storage (skipped quietly when it is too big). */
const KEY = 'billionaire.dataset.v1';

export async function readCachedDataset(): Promise<{
  data: FinanceDataset;
  savedAt: string;
} | null> {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    return raw ? (JSON.parse(raw) as { data: FinanceDataset; savedAt: string }) : null;
  } catch {
    return null;
  }
}

export async function writeCachedDataset(
  data: FinanceDataset | null,
  savedAt: string,
): Promise<void> {
  try {
    if (!data) globalThis.localStorage?.removeItem(KEY);
    else globalThis.localStorage?.setItem(KEY, JSON.stringify({ data, savedAt }));
  } catch {
    // Over the browser's storage quota: the app still works, it just loads fresh next time.
  }
}
