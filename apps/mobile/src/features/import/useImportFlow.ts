import type { ImportCommitResult, ImportPreview, ManualAccountRequest } from '@manaclaude/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText, isSuperseded } from '../../data/backend/client';
import { isBackendReady } from '../../data/backend/config';
import { refreshDataset } from '../../data/backend/sync';
import { getFinance } from '../../data/store';
import { haptic } from '../../design/haptics';
import {
  commitImport,
  createManualAccount,
  discardImport,
  errorCode,
  errorStatus,
  getImport,
  manualAccountsSupported,
  previewImport,
  undoImport,
  type PickedFile,
} from './importApi';
import {
  carryDecisions,
  commitLines,
  dateProblem,
  EMPTY_OPTIONS,
  EMPTY_REVIEW,
  planImport,
  resultFromRecord,
  rowSpan,
  sourcesOf,
  toRequest,
  type ImportOptions,
  type Review,
  type TotalLine,
} from './importFlow';
import { clearPendingImport, readPendingImport, rememberPendingImport } from './pendingImport';
import { pickStatementFile } from './pickFile';

export type Busy = 'pick' | 'preview' | 'save' | 'check' | 'undo' | 'account' | null;

/** A save whose outcome this phone has not seen. */
export interface Unsure {
  importId: string;
  fileName: string;
  /** saving: the backend says a save is under way. unknown: the backend could not be asked. */
  state: 'saving' | 'unknown';
}

export interface Saved {
  result: ImportCommitResult;
  fileName: string;
  /** Per account and currency, for the rows that were sent. Empty when read back after an interruption. */
  totals: TotalLine[];
}

export interface FlowState {
  file: PickedFile | null;
  options: ImportOptions;
  /** The choices the preview on screen was made from. */
  used: ImportOptions;
  preview: ImportPreview | null;
  review: Review;
  busy: Busy;
  error: string | null;
  notice: string | null;
  saved: Saved | null;
  unsure: Unsure | null;
  /** How many transactions an undo removed; null until one ran. */
  undone: number | null;
  /** The Worker can make a bank account by hand (POST /v1/accounts/manual). */
  manualAccounts: boolean;
  /** The preview was read with a column layout saved from an earlier file of the same bank. */
  savedLayout: boolean;
  /** First and last date in the whole file, known once a preview had no date limits. */
  fileSpan: { first: string; last: string } | null;
}

const START: FlowState = {
  file: null,
  options: EMPTY_OPTIONS,
  used: EMPTY_OPTIONS,
  preview: null,
  review: EMPTY_REVIEW,
  busy: null,
  error: null,
  notice: null,
  saved: null,
  unsure: null,
  undone: null,
  manualAccounts: false,
  savedLayout: false,
  fileSpan: null,
};

const CHANGED_NOTICE =
  'Your transactions changed while you were reviewing, so the preview was made again. Check it, then import.';

/**
 * The import screen's state and what can be done with it: pick a file, make
 * a preview from the choices, answer the review questions, save, find out
 * what happened to an interrupted save, and undo.
 */
export function useImportFlow() {
  const [state, setState] = useState<FlowState>(START);
  const ref = useRef(state);
  const alive = useRef(true);
  const set = useCallback((patch: Partial<FlowState>) => {
    if (!alive.current) return;
    ref.current = { ...ref.current, ...patch };
    setState(ref.current);
  }, []);

  const setOptions = useCallback(
    (patch: Partial<ImportOptions>) => set({ options: { ...ref.current.options, ...patch } }),
    [set],
  );

  const setReview = useCallback(
    (patch: Partial<Review>) => set({ review: { ...ref.current.review, ...patch } }),
    [set],
  );

  const decide = useCallback(
    (lines: readonly number[], decision: 'keep' | 'skip') => {
      const decisions = { ...ref.current.review.decisions };
      for (const line of lines) decisions[line] = decision;
      setReview({ decisions });
    },
    [setReview],
  );

  const pick = useCallback(async () => {
    set({ busy: 'pick', error: null });
    try {
      const picked = await pickStatementFile();
      if (!picked) return;
      const old = ref.current.preview;
      if (old && !ref.current.saved) void discardImport(old.importId).catch(() => {});
      set({ ...START, manualAccounts: ref.current.manualAccounts, file: picked });
    } catch (e) {
      set({ error: errorText(e) });
    } finally {
      set({ busy: null });
    }
  }, [set]);

  const loadPreview = useCallback(
    async (notice: string | null = null) => {
      const { file, options, preview: old, review } = ref.current;
      if (!file) return;
      const problem = dateProblem(options);
      if (problem) {
        set({ error: problem });
        return;
      }
      set({ busy: 'preview', error: null, notice });
      try {
        let asked = options;
        let next: ImportPreview;
        try {
          next = await previewImport(file, toRequest(asked));
        } catch (e) {
          // One destination was chosen, but the file holds several accounts: read
          // it without one, so each account in it can be placed below.
          if (!asked.accountId || !/multiple accounts/i.test(errorText(e))) throw e;
          asked = { ...asked, accountId: null };
          next = await previewImport(file, toRequest(asked));
          notice = 'This file holds more than one account. Choose where each one goes.';
        }
        // A column layout saved from an earlier file of this bank carries that
        // file's count of lines above the header. This file's header was found
        // where we said it is, so read it from there: otherwise its first rows
        // would be skipped without a word.
        const ownSkip = asked.skipRows ?? 0;
        const savedLayout = next.csv?.usedSavedMapping
          ? true
          : asked.mapping !== null && ref.current.savedLayout && asked.mapping === options.mapping;
        if (next.csv?.usedSavedMapping && next.mapping && next.mapping.skipRows !== ownSkip) {
          void discardImport(next.importId).catch(() => {});
          asked = { ...asked, mapping: { ...next.mapping, skipRows: ownSkip } };
          next = await previewImport(file, toRequest(asked));
        }
        // A file that names its one account, with a destination already picked:
        // show the pick against that name (it means the same to the backend).
        const names = sourcesOf(next).map((s) => s.name);
        const picked = asked.accountId;
        if (picked && names.length > 0)
          asked = {
            ...asked,
            accountId: null,
            sources: Object.fromEntries(
              names.map((n) => [n, { kind: 'account' as const, accountId: picked }]),
            ),
          };
        // Each preview is its own import record; the one it replaces is not needed any more.
        if (old) void discardImport(old.importId).catch(() => {});
        const sameErrors =
          old !== null && JSON.stringify(old.errors) === JSON.stringify(next.errors);
        set({
          preview: next,
          // Choices edited while the preview was loading stay as edited (and show as changed).
          options: asked === options ? ref.current.options : asked,
          used: asked,
          savedLayout,
          fileSpan:
            !next.dateRange?.from && !next.dateRange?.to
              ? rowSpan(next.rows)
              : ref.current.fileSpan,
          notice,
          review: {
            decisions: carryDecisions(old, next, review.decisions),
            skipErrors: review.skipErrors && sameErrors,
          },
        });
        // The review shows the stored side of each possible duplicate; load any the app does not have yet.
        const known = new Set(getFinance().transactions.map((t) => t.id));
        if (
          (next.duplicateCandidates ?? []).some((c) =>
            c.transactionIds.some((id) => !known.has(id)),
          )
        )
          void refreshDataset();
      } catch (e) {
        set({ error: errorText(e) });
      } finally {
        set({ busy: null });
      }
    },
    [set],
  );

  const finishSaved = useCallback(
    (result: ImportCommitResult, fileName: string, totals: TotalLine[]) => {
      void clearPendingImport(result.importId);
      set({ saved: { result, fileName, totals }, unsure: null, error: null, notice: null });
      haptic('confirm');
      void refreshDataset();
    },
    [set],
  );

  /** Asks the backend where an import stands and shows the answer. */
  const check = useCallback(
    async (importId: string, fileName: string, afterConflict = false) => {
      set({ busy: 'check', error: null });
      try {
        const record = await getImport(importId);
        if (record.status === 'committed') {
          finishSaved(resultFromRecord(record), record.fileName || fileName, []);
        } else if (record.status === 'committing') {
          set({ unsure: { importId, fileName, state: 'saving' } });
        } else {
          void clearPendingImport(importId);
          const here = ref.current.preview?.importId === importId;
          if (record.status === 'preview' && here && afterConflict) {
            set({ unsure: null });
            await refreshDataset();
            await loadPreview(CHANGED_NOTICE);
            return;
          }
          set({
            unsure: null,
            notice:
              record.status === 'undone'
                ? `The import of ${fileName} was saved and then undone. Nothing from it is in your accounts.`
                : here && record.status === 'preview'
                  ? 'Nothing was saved. Check the preview and press Import again.'
                  : `The import of ${fileName} stopped before anything was saved. Pick the file again to continue.`,
          });
        }
      } catch (e) {
        if (isSuperseded(e)) set({ unsure: null, error: errorText(e) });
        else set({ unsure: { importId, fileName, state: 'unknown' } });
      } finally {
        set({ busy: null });
      }
    },
    [finishSaved, loadPreview, set],
  );

  const save = useCallback(async () => {
    const { preview, options, used, review, file } = ref.current;
    if (!preview || ref.current.busy) return;
    const plan = planImport(preview, options, used, review, getFinance().accounts);
    if (plan.blockers.length > 0) return;
    const fileName = file?.name ?? preview.fileName;
    set({ busy: 'save', error: null, notice: null });
    await rememberPendingImport(preview.importId, fileName);
    try {
      const result = await commitImport(preview.importId, commitLines(preview, options, review));
      finishSaved(result, fileName, plan.totals);
    } catch (e) {
      const code = errorCode(e);
      const status = errorStatus(e);
      if (isSuperseded(e)) {
        set({ error: errorText(e) });
      } else if (code === 'import_preview_changed' || code === 'import_duplicates_require_review') {
        // Something was added to the account since the preview: look again, never save blind.
        void clearPendingImport(preview.importId);
        set({ busy: null });
        await refreshDataset();
        await loadPreview(CHANGED_NOTICE);
      } else if (status === 0 || status === 409 || status >= 500) {
        // No clear answer (connection lost, timeout, a conflict or a server error):
        // the save may have happened. Ask instead of guessing.
        set({ busy: null });
        await check(preview.importId, fileName, status === 409);
      } else {
        void clearPendingImport(preview.importId);
        set({ error: errorText(e) });
      }
    } finally {
      set({ busy: null });
    }
  }, [check, finishSaved, loadPreview, set]);

  const undo = useCallback(async () => {
    const saved = ref.current.saved;
    if (!saved) return;
    set({ busy: 'undo', error: null });
    try {
      const removed = await undoImport(saved.result.importId);
      set({ undone: removed });
      await refreshDataset();
    } catch (e) {
      set({ error: errorText(e) });
    } finally {
      set({ busy: null });
    }
  }, [set]);

  const reset = useCallback(() => {
    const { preview, saved } = ref.current;
    if (preview && !saved) void discardImport(preview.importId).catch(() => {});
    set({ ...START, manualAccounts: ref.current.manualAccounts });
  }, [set]);

  /** Makes a bank account by hand and selects it as the destination. Returns true when it worked. */
  const createAccount = useCallback(
    async (input: ManualAccountRequest): Promise<boolean> => {
      set({ busy: 'account', error: null });
      try {
        let id: string;
        try {
          id = (await createManualAccount(input)).id;
          await refreshDataset();
        } catch (e) {
          if (errorCode(e) !== 'account_exists') throw e;
          // Made already (perhaps by a first try whose answer was lost): use that one.
          await refreshDataset();
          const name = input.name.trim().toLowerCase();
          const existing = getFinance().accounts.find((a) => a.name.trim().toLowerCase() === name);
          if (!existing) throw e;
          id = existing.id;
        }
        set({ options: { ...ref.current.options, accountId: id } });
        return true;
      } catch (e) {
        set({ error: errorText(e) });
        return false;
      } finally {
        set({ busy: null });
      }
    },
    [set],
  );

  useEffect(() => {
    alive.current = true;
    if (isBackendReady()) {
      void manualAccountsSupported().then((manualAccounts) => set({ manualAccounts }));
      // A save that was cut off last time: find out what became of it.
      void readPendingImport().then((pending) => {
        if (pending && !ref.current.file) void check(pending.importId, pending.fileName);
      });
    }
    return () => {
      alive.current = false;
    };
    // Once, when the screen opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    state,
    setOptions,
    setReview,
    decide,
    pick,
    loadPreview,
    save,
    check,
    undo,
    reset,
    createAccount,
  };
}

export type ImportFlow = ReturnType<typeof useImportFlow>;
