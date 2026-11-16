import { useCallback, useEffect, useRef, useState } from 'react';
import type { BankHistoryDecisionRequest, BankHistoryReview } from '@manaclaude/shared';
import { errorText, isSuperseded } from '../../data/backend/client';
import { isBackendReady, useBackendConfig } from '../../data/backend/config';
import { refreshDataset } from '../../data/backend/sync';
import {
  bankReviewsStore,
  decideBankReview,
  errorCodeOf,
  errorStatusOf,
  getBankReview,
  historyStore,
  isUncertain,
} from './historyApi';

export interface ReviewNote {
  text: string;
  tone: 'done' | 'problem';
}

/** What a decision did, in plain words. */
export function decisionText(
  decision: 'keep' | 'skip',
  correction: boolean,
  replayed: boolean,
): string {
  const what =
    decision === 'keep'
      ? correction
        ? "Kept: the bank's change is saved on that transaction. Your notes and category stay."
        : 'Kept: the bank transaction is saved next to the Monefy entry. Nothing was merged.'
      : correction
        ? 'Skipped: the saved bank transaction stays as it was.'
        : 'Skipped: this bank transaction is not saved.';
  return replayed ? `${what} Your first try had already done it.` : what;
}

function resolvedText(r: BankHistoryReview): string {
  const correction = r.existingTransaction !== null;
  if (r.status === 'kept' || r.status === 'skipped')
    return decisionText(r.status === 'kept' ? 'keep' : 'skip', correction, false);
  if (r.status === 'obsolete')
    return 'The bank has since removed or changed this transaction, so there is nothing to decide here. A newer version, if any, shows up after the next sync.';
  return 'It is still waiting for a decision.';
}

/**
 * The bank rows held for review because they look like a saved Monefy entry.
 * One decision at a time, sent with the token the Worker gave with that
 * review. The list is read again after every decision, since tokens can
 * change. A lost answer is checked by reading that review back; "Try again"
 * sends the identical request.
 */
export function useBankReviews() {
  const config = useBackendConfig();
  const ready = isBackendReady(config);
  const store = bankReviewsStore.use();
  const [notes, setNotes] = useState<Record<string, ReviewNote>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  /** Reviews decided here, kept to show their outcome after they leave the pending list. */
  const [decided, setDecided] = useState<Record<string, BankHistoryReview>>({});
  /** Requests whose answer was lost, by review id. */
  const [unsure, setUnsure] = useState<Record<string, BankHistoryDecisionRequest>>({});
  const sending = useRef(false);
  const [shownScope, setShownScope] = useState(config.scope);
  if (shownScope !== config.scope) {
    setShownScope(config.scope);
    setNotes({});
    setUnsure({});
    setDecided({});
  }

  useEffect(() => {
    if (ready) void bankReviewsStore.load();
  }, [ready, config.scope]);

  const note = (id: string, n: ReviewNote) => setNotes((all) => ({ ...all, [id]: n }));

  const reload = useCallback(async () => {
    await Promise.all([bankReviewsStore.load(), historyStore.load()]);
    void refreshDataset();
  }, []);

  /** Reads one review back after a lost answer or a "resolved" refusal. */
  const readBack = useCallback(async (id: string, request: BankHistoryDecisionRequest | null) => {
    try {
      const { review } = await getBankReview(id);
      if (review.status === 'pending') {
        if (request) {
          setUnsure((all) => ({ ...all, [id]: request }));
          note(id, {
            text: "Your Worker didn't answer, and this transaction is still waiting. Try again sends the same decision.",
            tone: 'problem',
          });
        }
      } else {
        setUnsure((all) => {
          const { [id]: _gone, ...rest } = all;
          return rest;
        });
        note(id, { text: resolvedText(review), tone: 'done' });
      }
    } catch (e) {
      if (isSuperseded(e)) return;
      if (request) setUnsure((all) => ({ ...all, [id]: request }));
      note(id, {
        text: `${request ? "Your Worker didn't answer, so the app doesn't know whether the decision was saved. " : ''}${errorText(e)}`,
        tone: 'problem',
      });
    }
  }, []);

  const send = useCallback(
    async (review: BankHistoryReview, request: BankHistoryDecisionRequest) => {
      if (sending.current) return;
      sending.current = true;
      setBusyId(review.id);
      setDecided((all) => ({ ...all, [review.id]: review }));
      try {
        const r = await decideBankReview(review.id, request);
        setUnsure((all) => {
          const { [review.id]: _gone, ...rest } = all;
          return rest;
        });
        note(review.id, {
          text: decisionText(r.decision, review.existingTransaction !== null, r.replayed),
          tone: 'done',
        });
        await reload();
      } catch (e) {
        if (isSuperseded(e)) return;
        const code = errorCodeOf(e);
        if (code === 'history_review_resolved') {
          await readBack(review.id, null);
          await reload();
        } else if (code === 'history_policy_changed') {
          note(review.id, {
            text: 'Something changed on your Worker since this was shown (a sync, an import or a settings change), so nothing was saved. It has been read again; look at it before deciding.',
            tone: 'problem',
          });
          await reload();
        } else if (code === 'history_review_changed') {
          note(review.id, {
            text: 'Your saved bank transaction changed since the bank proposed this change, so nothing was saved. Sync the account again for a fresh proposal; your history stays as it is.',
            tone: 'problem',
          });
          await reload();
        } else if (code === 'history_transaction_excluded') {
          note(review.id, {
            text: 'The current history settings no longer let this bank transaction be kept. You can still skip it.',
            tone: 'problem',
          });
          await reload();
        } else if (errorStatusOf(e) === 404) {
          note(review.id, { text: 'This review is gone from your Worker.', tone: 'problem' });
          await reload();
        } else if (isUncertain(e)) {
          await readBack(review.id, request);
        } else {
          note(review.id, { text: errorText(e), tone: 'problem' });
        }
      } finally {
        sending.current = false;
        setBusyId(null);
      }
    },
    [readBack, reload],
  );

  const decide = useCallback(
    (review: BankHistoryReview, decision: 'keep' | 'skip') =>
      send(review, unsure[review.id] ?? { previewToken: review.previewToken, decision }),
    [send, unsure],
  );

  const retry = useCallback(
    (review: BankHistoryReview) => {
      const request = unsure[review.id];
      return request ? send(review, request) : Promise.resolve();
    },
    [send, unsure],
  );

  return { ready, store, notes, decided, busyId, unsure, decide, retry, reload };
}
