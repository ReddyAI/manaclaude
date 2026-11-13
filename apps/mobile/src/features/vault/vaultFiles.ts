import type { ImportRecord, ImportStatus } from '@manaclaude/shared';

/**
 * The rules of the stored-statements screens, with no screen in them.
 *
 * GET /v1/vault sends one record per stored copy, and every preview of a
 * file stores its own copy. So one statement that was previewed three times
 * and imported once arrives as three records. Here they become one file.
 */
export interface StoredFile {
  /** Names the file in the app's routes: the id of `record`. */
  id: string;
  /** The copy that says most about the file: a saved import before an undone one, before a failed one, before a preview. */
  record: ImportRecord;
  /** Every record of the same bytes, newest first. */
  copies: ImportRecord[];
}

const RANK: Record<ImportStatus, number> = {
  committed: 0,
  committing: 1,
  undone: 2,
  failed: 3,
  preview: 4,
  needs_mapping: 4,
  discarded: 4,
};
const rank = (r: ImportRecord) => RANK[r.status] ?? 5;

/** Records with the same bytes belong to one file. The newest file comes first. */
export function storedFiles(records: readonly ImportRecord[]): StoredFile[] {
  const groups = new Map<string, ImportRecord[]>();
  for (const r of records) {
    // Records from before hashes were kept, if any, stand alone.
    const key = r.sha256 ? `sha:${r.sha256}` : `id:${r.id}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const files: StoredFile[] = [];
  for (const group of groups.values()) {
    const copies = [...group].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const record = [...copies].sort((a, b) => rank(a) - rank(b))[0]!;
    files.push({ id: record.id, record, copies });
  }
  return files.sort((a, b) => b.copies[0]!.createdAt.localeCompare(a.copies[0]!.createdAt));
}

/** The file that holds this record id (any of its copies). */
export function findStoredFile(files: readonly StoredFile[], id: string): StoredFile | null {
  return files.find((f) => f.copies.some((c) => c.id === id)) ?? null;
}

/** Imports of the file that reached the transactions at some point, or failed: what History lists. */
export function importsOf(file: StoredFile): ImportRecord[] {
  return file.copies.filter((c) => rank(c) < 4);
}

export type FileState = 'imported' | 'saving' | 'undone' | 'failed' | 'not_imported';

export function fileState(record: ImportRecord): FileState {
  switch (record.status) {
    case 'committed':
      return 'imported';
    case 'committing':
      return 'saving';
    case 'undone':
      return 'undone';
    case 'failed':
      return 'failed';
    default:
      return 'not_imported';
  }
}

export const STATE_LABEL: Record<FileState, string> = {
  imported: 'Imported',
  saving: 'Saving',
  undone: 'Import undone',
  failed: 'Could not be read',
  not_imported: 'Not imported',
};

const FORMAT: Record<string, string> = {
  csv: 'CSV',
  qif: 'QIF',
  ofx: 'OFX',
  pdf: 'PDF',
  sure_ndjson: 'Sure export',
  actual_csv: 'Actual CSV',
};

export function formatLabel(format: string): string {
  return FORMAT[format] ?? format.toUpperCase();
}

/** "840 bytes", "12 KB", "1.4 MB". */
export function sizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Can the file be read on screen as text? PDFs cannot. */
export function isTextFile(record: Pick<ImportRecord, 'format' | 'contentType'>): boolean {
  return record.format !== 'pdf' && !/pdf/i.test(record.contentType);
}

/** The type to hand to another app. The stored type when it says something, else by the file's ending. */
export function mimeOf(record: Pick<ImportRecord, 'format' | 'contentType' | 'fileName'>): string {
  if (record.format === 'pdf') return 'application/pdf';
  const stored = record.contentType.split(';')[0]!.trim().toLowerCase();
  if (stored && stored !== 'application/octet-stream') return stored;
  return /\.csv$/i.test(record.fileName) ? 'text/csv' : 'text/plain';
}

/** A file name that is safe as one path part on the phone. */
export function safeFileName(name: string): string {
  const last = name.split(/[\\/]/).pop() ?? '';
  return (
    last
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^\.+/, '')
      .slice(-120) || 'statement'
  );
}

/** Lines shown on screen. A long file is cut here; the stored file itself is whole. */
export const TEXT_LINES_SHOWN = 300;

export interface TextExcerpt {
  lines: string[];
  /** Lines in the whole file. */
  total: number;
}

export function excerpt(text: string, limit = TEXT_LINES_SHOWN): TextExcerpt {
  const clean = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n$/, '');
  if (clean === '') return { lines: [], total: 0 };
  const all = clean.split('\n');
  return { lines: all.slice(0, limit), total: all.length };
}
