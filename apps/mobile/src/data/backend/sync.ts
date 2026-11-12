import AsyncStorage from '@react-native-async-storage/async-storage';
import type { FinanceDataset, Transaction } from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import { getFinance, setFinance, updateFinance } from '../store';
import { api, errorText, isSuperseded } from './client';
import {
  getBackendConfig,
  isBackendReady,
  loadBackendConfig,
  subscribeBackendConfig,
} from './config';
import { readCachedDataset, writeCachedDataset } from './datasetCache';
import {
  applyLoadedSettings,
  loadWaitingSettings,
  resetSettingsSync,
  settingsMarker,
  watchSettingChanges,
} from './settingsSync';
import { getBackendStatus, reportBackendError, setBackendStatus } from './status';

/**
 * Loads your data from the backend into the app's data store.
 *
 * - With a URL and token set: the last copy loaded from that same backend
 *   opens first (so the app works offline), then GET /v1/dataset replaces it.
 *   The backend's settings arrive with it (settingsSync.ts).
 * - If the backend can't be reached, the last loaded data stays and the
 *   status carries a plain error the app shows in a banner.
 * - Without a URL or token: the sample data, as before.
 */

export {
  dismissBackendError,
  getBackendStatus,
  reportBackendError,
  subscribeBackendStatus,
  useBackendStatus,
  type BackendStatus,
} from './status';

// -- receipt photos ------------------------------------------------------------------
// The backend keeps receipt images in R2; the photo on this phone stays the one
// shown. This map (server receipt id to local uri) puts it back after each load.
const RECEIPT_URIS_KEY = 'billionaire.receiptUris';
let receiptUris: Record<string, string> = {};

async function loadReceiptUris(): Promise<void> {
  try {
    receiptUris = JSON.parse((await AsyncStorage.getItem(RECEIPT_URIS_KEY)) ?? '{}') as Record<
      string,
      string
    >;
  } catch {
    receiptUris = {};
  }
}

export function rememberReceiptUri(receiptId: string, uri: string): void {
  receiptUris = { ...receiptUris, [receiptId]: uri };
  AsyncStorage.setItem(RECEIPT_URIS_KEY, JSON.stringify(receiptUris)).catch(() => {});
}

function withLocalReceipts(data: FinanceDataset): FinanceDataset {
  if (Object.keys(receiptUris).length === 0) return data;
  return {
    ...data,
    receipts: data.receipts.map((r) =>
      receiptUris[r.id] ? { ...r, localUri: receiptUris[r.id] } : r,
    ),
  };
}

// -- loading ---------------------------------------------------------------------------
// Everything here is tied to one backend: the config's `scope`, which changes
// whenever the URL or token changes or the token is forgotten. A request, a
// saved copy or a timer started for one scope never touches the screen once
// another scope is selected.

/** The backend whose data is on screen; null while the sample data is shown. */
let liveScope: string | null = null;
let inflight: { scope: string; promise: Promise<boolean> } | null = null;

/** True when the data on screen came from the backend selected now, so changes may be saved to it. */
export function canSaveToBackend(): boolean {
  return isBackendReady() && liveScope !== null && liveScope === getBackendConfig().scope;
}

/** GET /v1/dataset into the store. Keeps the current data when it fails. Returns true on success. */
export function refreshDataset(): Promise<boolean> {
  if (!isBackendReady()) return Promise.resolve(false);
  const scope = getBackendConfig().scope;
  if (inflight?.scope === scope) return inflight.promise;
  watchSettingChanges();
  setBackendStatus({ loading: true });
  const marker = settingsMarker();
  const current = () => getBackendConfig().scope === scope && isBackendReady();
  const entry = { scope, promise: Promise.resolve(false) };
  entry.promise = (async () => {
    try {
      const data = await api<FinanceDataset>('GET', '/v1/dataset', undefined, {
        timeoutMs: 60_000,
      });
      // The backend was changed or forgotten while this was on its way: drop the answer.
      if (!current()) return false;
      const now = new Date().toISOString();
      setFinance(withLocalReceipts(data));
      liveScope = scope;
      setBackendStatus({
        mode: 'live',
        loading: false,
        error: null,
        lastLoadedAt: now,
        fromCache: false,
      });
      applyLoadedSettings(data.settings, scope, marker);
      void writeCachedDataset(data, now, scope);
      return true;
    } catch (e) {
      if (isSuperseded(e) || !current()) return false;
      const { lastLoadedAt } = getBackendStatus();
      setBackendStatus({
        loading: false,
        error: lastLoadedAt
          ? `${errorText(e)} Showing your data from ${new Date(lastLoadedAt).toLocaleString()}.`
          : errorText(e),
      });
      return false;
    } finally {
      if (inflight === entry) inflight = null;
    }
  })();
  inflight = entry;
  return entry.promise;
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

/** Reload soon, once, after a burst of changes. */
export function scheduleRefresh(delayMs = 800): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshDataset();
  }, delayMs);
}

/** The selected backend changed (or the app just started): show the right data for it. */
async function applyMode(): Promise<void> {
  const scope = getBackendConfig().scope;
  // Leave the old backend completely before anything from the new one shows.
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
  resetSettingsSync(scope);
  if (liveScope !== null && liveScope !== scope) {
    liveScope = null;
    setFinance(createSampleData());
    void writeCachedDataset(null, '', '');
  }
  if (liveScope === null)
    setBackendStatus({
      mode: 'sample',
      loading: false,
      error: null,
      lastLoadedAt: null,
      fromCache: false,
    });
  if (!isBackendReady()) return;
  if (liveScope === null) {
    const cached = await readCachedDataset(scope);
    // Checked again after the read: the backend may have changed meanwhile,
    // or a fresh load may already be on screen.
    if (cached && liveScope === null && isBackendReady() && getBackendConfig().scope === scope) {
      setFinance(withLocalReceipts(cached.data));
      liveScope = scope;
      setBackendStatus({ mode: 'live', lastLoadedAt: cached.savedAt, fromCache: true });
    }
    if (getBackendConfig().scope !== scope) return;
  }
  await refreshDataset();
}

let started = false;
let lastScope = '';
let unsubscribeConfig: (() => void) | null = null;

/** Once at app start: read the backend settings, then load. Follows later changes in Settings. */
export async function startBackend(): Promise<void> {
  if (started) return;
  started = true;
  await Promise.all([loadReceiptUris(), loadWaitingSettings()]);
  watchSettingChanges();
  const cfg = await loadBackendConfig();
  lastScope = cfg.scope;
  unsubscribeConfig = subscribeBackendConfig(() => {
    const { scope } = getBackendConfig();
    if (scope === lastScope) return;
    lastScope = scope;
    void applyMode();
  });
  await applyMode();
}

/** Tests: back to a newly opened app showing the sample data. */
export function resetBackendForTests(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
  started = false;
  lastScope = '';
  liveScope = null;
  inflight = null;
  unsubscribeConfig?.();
  unsubscribeConfig = null;
  setBackendStatus({
    mode: 'sample',
    loading: false,
    error: null,
    lastLoadedAt: null,
    fromCache: false,
  });
}

// -- saving changes ----------------------------------------------------------------------

/**
 * Sends one change to the backend after the screen already shows it. When
 * the backend is not set up, or its data has not loaded yet (the sample data
 * is still on screen), this does nothing: a change to sample data is never
 * sent. When the save fails, the change is undone (if nothing else changed
 * since) and the banner says what was not saved. An answer that arrives after
 * the backend was changed or forgotten is ignored.
 */
export function persist<T>(
  label: string,
  before: FinanceDataset,
  call: () => Promise<T>,
  opts: { onSaved?: (result: T) => void; refreshAfter?: boolean } = {},
): Promise<T | null> {
  if (!canSaveToBackend()) return Promise.resolve(null);
  const scope = getBackendConfig().scope;
  const after = getFinance();
  return call().then(
    (result) => {
      if (getBackendConfig().scope !== scope) return null;
      opts.onSaved?.(result);
      if (opts.refreshAfter) scheduleRefresh();
      return result;
    },
    (e: unknown) => {
      // The data on screen is no longer this backend's: nothing to undo or report.
      if (isSuperseded(e) || getBackendConfig().scope !== scope) return null;
      if (getFinance() === after) setFinance(before);
      else scheduleRefresh();
      reportBackendError(`Not saved (${label}). ${errorText(e)}`);
      return null;
    },
  );
}

/** Puts the backend's copy of some transactions into the store (adding any that are new). */
export function mergeTransactions(
  list: readonly Transaction[],
  replaceIds: Record<string, string> = {},
): void {
  if (list.length === 0) return;
  const byId = new Map(list.map((t) => [t.id, t]));
  const dropped = new Set(Object.keys(replaceIds));
  updateFinance((d) => {
    const kept = d.transactions.filter((t) => !dropped.has(t.id)).map((t) => byId.get(t.id) ?? t);
    const known = new Set(kept.map((t) => t.id));
    return { ...d, transactions: [...kept, ...list.filter((t) => !known.has(t.id))] };
  });
}
