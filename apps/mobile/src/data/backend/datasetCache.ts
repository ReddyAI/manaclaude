import { File, Paths } from 'expo-file-system';
import type { FinanceDataset } from '@manaclaude/shared';

/**
 * The last dataset loaded from the backend, kept in a file so the app opens
 * with your data even when the backend can't be reached. (The web build uses
 * datasetCache.web.ts.)
 */
const NAME = 'billionaire-dataset.json';

export async function readCachedDataset(): Promise<{
  data: FinanceDataset;
  savedAt: string;
} | null> {
  try {
    const file = new File(Paths.document, NAME);
    if (!file.exists) return null;
    return JSON.parse(await file.text()) as { data: FinanceDataset; savedAt: string };
  } catch {
    return null;
  }
}

export async function writeCachedDataset(
  data: FinanceDataset | null,
  savedAt: string,
): Promise<void> {
  try {
    const file = new File(Paths.document, NAME);
    if (!data) {
      if (file.exists) file.delete();
      return;
    }
    if (!file.exists) file.create();
    file.write(JSON.stringify({ data, savedAt }));
  } catch {
    // A missing cache only means a slower start next time.
  }
}
