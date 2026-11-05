import type { Id, IsoDateTime } from '@manaclaude/shared';

/** Make an id for a new row. The backend passes crypto.randomUUID; tests pass a counter. */
export type IdFactory = (kind: string) => Id;

export function defaultIdFactory(kind: string): Id {
  return `${kind}_${crypto.randomUUID()}`;
}

export interface Update<T> {
  id: Id;
  /** Only the fields that change. Apply with a plain SET; `updatedAt` is included. */
  changes: Partial<T>;
  reason: string;
}

export interface SyncClock {
  now: IsoDateTime;
}
