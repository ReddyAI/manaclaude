import { File, Paths } from 'expo-file-system';
import type { FinanceDataset } from '@manaclaude/shared';

/**
 * The last dataset loaded from the backend, kept in a file so the app opens
 * with your data even when the backend can't be reached. (The web build uses
 * datasetCache.web.ts.)
 *
 * The copy records which backend it came from (the config's `scope`). A copy
 * from another backend, or one saved before scopes existed, is never shown.
 */
const NAME = 'billionaire-dataset.json';

export interface CachedDataset {
  data: FinanceDataset;
  savedAt: string;
}

export async function readCachedDataset(scope: string): Promise<CachedDataset | null> {
  try {
    const file = new File(Paths.document, NAME);
    if (!file.exists) return null;
    const saved = JSON.parse(await file.text()) as Partial<CachedDataset> & { scope?: string };
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
    const file = new File(Paths.document, NAME);
    if (!data) {
      if (file.exists) file.delete();
      return;
    }
    if (!file.exists) file.create();
    file.write(JSON.stringify({ scope, data, savedAt }));
  } catch {
    // A missing cache only means a slower start next time.
  }
}
