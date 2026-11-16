import { useEffect, useRef, useState } from 'react';
import type { HistoryPolicySaveRequest, HistoryRead, PolicyPreview } from '@manaclaude/shared';
import { errorText, isSuperseded } from '../../data/backend/client';
import { getBackendConfig, useBackendConfig } from '../../data/backend/config';
import {
  errorCodeOf,
  historyStore,
  isUncertain,
  previewHistoryPolicy,
  saveHistoryPolicy,
} from './historyApi';
import {
  draftFrom,
  draftProblems,
  EMPTY_ACCOUNT,
  policyFrom,
  type AccountDraft,
  type PolicyDraft,
} from './historyModel';

export type EditorResult =
  | { kind: 'saved'; replayed: boolean; version: number }
  | { kind: 'changed' }
  | { kind: 'error'; text: string };

/**
 * The history-source settings being edited, the Worker's check of them, and
 * the save. A save sends exactly what was checked: the policy, version and
 * token from that preview. Any edit throws the check away. A lost answer
 * keeps the request; "Try again" sends it unchanged, and the Worker answers
 * `replayed` if the first one was saved. A stale check is never refreshed and
 * sent again on its own.
 */
export function usePolicyEditor(governedIds: readonly string[], names: Record<string, string>) {
  const { value: saved } = historyStore.use();
  const { scope } = useBackendConfig();
  const [draft, setDraft] = useState<PolicyDraft>({ defaultCutoff: '', accounts: {} });
  const [loadedFrom, setLoadedFrom] = useState<HistoryRead | null>(null);
  const [preview, setPreview] = useState<PolicyPreview | null>(null);
  const [busy, setBusy] = useState<'check' | 'save' | null>(null);
  const [result, setResult] = useState<EditorResult | null>(null);
  /** A save whose answer was lost: sent again unchanged by retry(). */
  const [unsure, setUnsure] = useState<HistoryPolicySaveRequest | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const sending = useRef(false);

  // Another backend: nothing of the old one's draft, check or save carries over.
  const [shownScope, setShownScope] = useState(scope);
  if (shownScope !== scope) {
    setShownScope(scope);
    setPreview(null);
    setUnsure(null);
    setResult(null);
    setLoadedFrom(null);
    setDraft({ defaultCutoff: '', accounts: {} });
  }

  // The Worker's saved settings become the draft when they arrive, and again
  // when a new version is saved; a reread of the same version keeps edits.
  if (saved && saved !== loadedFrom) {
    if (!loadedFrom || loadedFrom.version !== saved.version) setDraft(draftFrom(saved.policy));
    setLoadedFrom(saved);
  }

  useEffect(() => {
    void historyStore.load();
  }, [scope]);

  const edit = (next: PolicyDraft) => {
    setDraft(next);
    setPreview(null);
    setProblems([]);
    setResult(null);
  };

  const setCutoff = (defaultCutoff: string) => edit({ ...draft, defaultCutoff });

  const setAccount = (id: string, patch: Partial<AccountDraft>) =>
    edit({
      ...draft,
      accounts: {
        ...draft.accounts,
        [id]: { ...(draft.accounts[id] ?? EMPTY_ACCOUNT), ...patch },
      },
    });

  const check = async () => {
    if (sending.current) return;
    const governed = governedIds.map((id) => ({ id, name: names[id] ?? id }));
    const found = draftProblems(draft, governed);
    setProblems(found);
    setResult(null);
    if (found.length > 0) return;
    sending.current = true;
    setBusy('check');
    const asked = getBackendConfig().scope;
    try {
      const p = await previewHistoryPolicy(policyFrom(draft, governedIds));
      if (getBackendConfig().scope === asked) setPreview(p);
    } catch (e) {
      if (!isSuperseded(e)) setResult({ kind: 'error', text: errorText(e) });
    } finally {
      sending.current = false;
      setBusy(null);
    }
  };

  const send = async (request: HistoryPolicySaveRequest) => {
    if (sending.current) return;
    sending.current = true;
    setBusy('save');
    setResult(null);
    try {
      const answer = await historyStore.mutate(
        () => saveHistoryPolicy(request),
        (_old, r) => ({ version: r.version, policy: r.policy, accounts: r.accounts }),
      );
      setUnsure(null);
      setPreview(null);
      setResult({ kind: 'saved', replayed: answer.replayed, version: answer.version });
    } catch (e) {
      if (isSuperseded(e)) return;
      const code = errorCodeOf(e);
      if (code === 'history_transition_conflict') {
        // History refuses the change: show the Worker's own list of what blocks it.
        setUnsure(null);
        setPreview(null);
        sending.current = false;
        try {
          setPreview(await previewHistoryPolicy(request.policy));
        } catch (again) {
          if (!isSuperseded(again)) setResult({ kind: 'error', text: errorText(again) });
        }
      } else if (code === 'history_policy_changed') {
        // Something changed since the check. Never refresh the token and resend.
        setUnsure(null);
        setPreview(null);
        setResult({ kind: 'changed' });
        void historyStore.load();
      } else if (isUncertain(e)) {
        setUnsure(request);
      } else {
        setUnsure(null);
        setResult({ kind: 'error', text: errorText(e) });
      }
    } finally {
      sending.current = false;
      setBusy(null);
    }
  };

  const save = async () => {
    if (!preview?.allowed) return;
    await send({
      policy: preview.policy,
      expectedVersion: preview.expectedVersion,
      previewToken: preview.previewToken,
    });
  };

  const retry = async () => {
    if (unsure) await send(unsure);
  };

  /** Drop a lost save and read what the Worker has now. */
  const forget = () => {
    setUnsure(null);
    setResult(null);
    void historyStore.load();
  };

  return {
    saved,
    draft,
    preview,
    busy,
    result,
    unsure,
    problems,
    setCutoff,
    setAccount,
    check,
    save,
    retry,
    forget,
  };
}

export type PolicyEditor = ReturnType<typeof usePolicyEditor>;
