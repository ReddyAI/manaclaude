import type { ImportRecord } from '@manaclaude/shared';
import { vaultFileBlob } from './vaultApi';
import type { OpenResult } from './openStoredFile';

/**
 * The browser's version of openStoredFile: the file is fetched with the API
 * token and saved through the browser's own download, under its own name.
 */

export const OPEN_LABEL = 'Download the file';
export const OPEN_HINT =
  'Download the file saves a copy through your browser, exactly as it was uploaded.';

/** Nothing is kept by the app on the web. */
export function clearOpenedFiles(): void {}

export async function openStoredFile(
  record: Pick<ImportRecord, 'id' | 'fileName' | 'contentType' | 'format'>,
): Promise<OpenResult> {
  const blob = await vaultFileBlob(record.id);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = record.fileName || 'statement';
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // The browser has taken the file by now; let go of the copy in memory.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return 'downloaded';
}
