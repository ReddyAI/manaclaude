import type { Connection, LocalDate } from '@manaclaude/shared';

/**
 * Cursors are small JSON strings kept in Connection.syncCursor. Most adapters
 * only need "everything since this date", which is what SinceCursor holds.
 */
export interface SinceCursor {
  since: LocalDate;
}

export function parseCursor<T extends object>(cursor: string | null | undefined): T | null {
  if (!cursor) return null;
  try {
    const value: unknown = JSON.parse(cursor);
    return value !== null && typeof value === 'object' ? (value as T) : null;
  } catch {
    return null;
  }
}

export function encodeCursor(value: object): string {
  return JSON.stringify(value);
}

export function readSince(connection: Connection): LocalDate | null {
  const parsed = parseCursor<Partial<SinceCursor>>(connection.syncCursor);
  return typeof parsed?.since === 'string' ? parsed.since : null;
}

export function sinceCursor(today: LocalDate): string {
  return encodeCursor({ since: today } satisfies SinceCursor);
}
