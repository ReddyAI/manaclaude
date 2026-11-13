import type { ImportRecord } from '@manaclaude/shared';
import { Directory, File, Paths } from 'expo-file-system';
import { BackendError, supersededError } from '../../data/backend/client';
import { getBackendConfig } from '../../data/backend/config';
import { fileErrorText, vaultFileRequest } from './vaultApi';
import { mimeOf, safeFileName } from './vaultFiles';

/**
 * Opening a stored statement on the phone: the file is downloaded into the
 * app's private cache and handed to whichever app on the phone opens that
 * kind of file (a PDF viewer, a spreadsheet app). The web build has its own
 * version of this file, which saves the file through the browser.
 */

export const OPEN_LABEL = 'Open in another app';
export const OPEN_HINT =
  "Open in another app downloads the file to this phone and hands it to an app that can show it. One copy stays in this app's private storage until you open another file or come back to the list.";

export type OpenResult =
  /** Handed to another app. */
  | 'opened'
  /** Saved by the browser (web only). */
  | 'downloaded'
  /** No app on the phone opens this kind of file. */
  | 'no_app';

function cacheFolder(): Directory {
  return new Directory(Paths.cache, 'statements');
}

/** Removes the copies earlier opens left in the app's cache. Safe to call any time. */
export function clearOpenedFiles(): void {
  try {
    const dir = cacheFolder();
    if (dir.exists) dir.delete();
  } catch {
    // Nothing to remove, or the folder is in use: the next open tries again.
  }
}

/** The status code the download error names, if any. */
function statusOf(e: unknown): number {
  const text = e instanceof Error ? e.message : '';
  const code = /\b(4\d\d|5\d\d)\b/.exec(text)?.[1];
  return code ? Number(code) : 0;
}

export async function openStoredFile(
  record: Pick<ImportRecord, 'id' | 'fileName' | 'contentType' | 'format'>,
): Promise<OpenResult> {
  const scope = getBackendConfig().scope;
  const stale = () => getBackendConfig().scope !== scope;
  const { url, headers } = vaultFileRequest(record.id);
  clearOpenedFiles();
  const dir = cacheFolder();
  dir.create({ intermediates: true, idempotent: true });
  const target = new File(dir, safeFileName(record.fileName));
  let file: File;
  try {
    file = await File.downloadFileAsync(url, target, { headers, idempotent: true });
  } catch (e) {
    clearOpenedFiles();
    if (stale()) throw supersededError();
    const status = statusOf(e);
    throw status
      ? new BackendError(status, 'error', fileErrorText(status, ''))
      : new BackendError(
          0,
          'offline',
          'The file could not be downloaded. Check your connection and try again.',
        );
  }
  // The backend changed while the file was on its way: it belongs to the old one.
  if (stale()) {
    clearOpenedFiles();
    throw supersededError();
  }
  const mimeType = mimeOf(record);
  if (!(await File.canPreview(file, { mimeType }))) {
    clearOpenedFiles();
    return 'no_app';
  }
  await File.preview(file, { mimeType, title: record.fileName });
  return 'opened';
}
