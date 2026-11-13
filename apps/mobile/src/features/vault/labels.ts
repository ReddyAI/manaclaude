import type { BadgeTone } from '../../design/components/Controls';
import type { ImportRecord } from '@manaclaude/shared';
import type { FileState } from './vaultFiles';

export const STATE_TONE: Record<FileState, BadgeTone> = {
  imported: 'income',
  saving: 'pending',
  undone: 'neutral',
  failed: 'danger',
  not_imported: 'neutral',
};

/** What one import of a file did, in a sentence. */
export function importSentence(r: ImportRecord): string {
  const day = (r.committedAt ?? r.createdAt).slice(0, 10);
  switch (r.status) {
    case 'committed':
      return `${day}: ${r.rowsAdded} added, ${r.rowsMatched} already there, ${r.rowsSkipped} left out.`;
    case 'undone':
      return `${day}: ${r.rowsAdded} added, then removed by undo.`;
    case 'committing':
      return `${day}: a save was started and has not finished.`;
    case 'failed':
      return `${day}: the file could not be read.`;
    default:
      return `${day}: previewed, not imported.`;
  }
}
