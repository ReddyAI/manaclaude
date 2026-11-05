import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';
import type { FinanceDataset, Transaction } from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import { getSettings, subscribeSettings } from '../settingsStore';
import { getFinance, setFinance, updateFinance } from '../store';
import { api, errorText } from './client';
import {
  getBackendConfig,
  isBackendReady,
  loadBackendConfig,
  subscribeBackendConfig,
} from './config';
import { readCachedDataset, writeCachedDataset } from './datasetCache';

/**
 * Loads your data from the backend into the app's data store.
 *
 * - With a URL and token set: the last loaded copy opens first (so the app
 *   works offline), then GET /v1/dataset replaces it.
 * - If the backend can't be reached, the last loaded data stays and the
 *   status carries a plain error the app shows in a banner.
 * - Without a URL or token: the sample data, as before.
 */

export interface BackendStatus {
  mode: 'sample' | 'live';
  loading: boolean;
  /** A plain sentence for the banner; null when all is well. */
  error: string | null;
  /** When the data on screen was loaded from the backend. */
  lastLoadedAt: string | null;
  /** The data on screen came from the saved copy, not a fresh load. */
  fromCache: boolean;
}

type Listener = () => void;
let status: BackendStatus = {
  mode: 'sample',
  loading: false,
  error: null,
  lastLoadedAt: null,
  fromCache: false,
};
const listeners = new Set<Listener>();

function setStatus(patch: Partial<BackendStatus>): void {
  status = { ...status, ...patch };
  for (const l of listeners) l();
}

export function getBackendStatus(): BackendStatus {
  return status;
}

export function subscribeBackendStatus(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBackendStatus(): BackendStatus {
  return useSyncExternalStore(subscribeBackendStatus, getBackendStatus, getBackendStatus);
}

export function reportBackendError(message: string): void {
  setStatus({ error: message });
}

export function dismissBackendError(): void {
  setStatus({ error: null });
}

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
let inflight: Promise<boolean> | null = null;

/** GET /v1/dataset into the store. Keeps the current data when it fails. Returns true on success. */
export function refreshDataset(): Promise<boolean> {
  if (!isBackendReady()) return Promise.resolve(false);
  if (inflight) return inflight;
  setStatus({ loading: true });
  inflight = (async () => {
    try {
      const data = await api<FinanceDataset>('GET', '/v1/dataset', undefined, {
        timeoutMs: 60_000,
      });
      const now = new Date().toISOString();
      setFinance(withLocalReceipts(data));
      setStatus({ mode: 'live', loading: false, error: null, lastLoadedAt: now, fromCache: false });
      void writeCachedDataset(data, now);
      return true;
    } catch (e) {
      setStatus({
        loading: false,
        error: status.lastLoadedAt
          ? `${errorText(e)} Showing your data from ${new Date(status.lastLoadedAt).toLocaleString()}.`
          : errorText(e),
      });
      return false;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
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

async function applyMode(): Promise<void> {
  if (!isBackendReady()) {
    if (status.mode === 'live') {
      setFinance(createSampleData());
      void writeCachedDataset(null, '');
    }
    setStatus({
      mode: 'sample',
      loading: false,
      error: null,
      lastLoadedAt: null,
      fromCache: false,
    });
    return;
  }
  if (status.mode === 'sample') {
    const cached = await readCachedDataset();
    if (cached && isBackendReady()) {
      setFinance(withLocalReceipts(cached.data));
      setStatus({ mode: 'live', lastLoadedAt: cached.savedAt, fromCache: true });
    }
  }
  await refreshDataset();
}

// -- settings ------------------------------------------------------------------------------
// The Worker reads some settings (AI switch, MCP write tools, money policies), so
// changes made in Settings are sent to PATCH /v1/settings.
const SERVER_SETTINGS = [
  'displayCurrencyMode',
  'primaryCurrency',
  'secondaryCurrency',
  'aiEnabled',
  'aiProvider',
  'look',
  'colorScheme',
  'hapticsEnabled',
  'dashboardLayout',
  'moneyPolicies',
  'mcpWriteToolsEnabled',
  'weekStartsOn',
] as const;
let lastSentSettings = '';
let settingsTimer: ReturnType<typeof setTimeout> | null = null;

function serverSettings(): Record<string, unknown> {
  const s = getSettings() as unknown as Record<string, unknown>;
  return Object.fromEntries(SERVER_SETTINGS.map((k) => [k, s[k]]));
}

function watchSettings(): void {
  lastSentSettings = JSON.stringify(serverSettings());
  subscribeSettings(() => {
    const body = serverSettings();
    const key = JSON.stringify(body);
    if (key === lastSentSettings || !isBackendReady()) return;
    if (settingsTimer) clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => {
      lastSentSettings = key;
      api('PATCH', '/v1/settings', body).catch((e: unknown) =>
        reportBackendError(`Settings not saved on the backend. ${errorText(e)}`),
      );
    }, 600);
  });
}

let started = false;
let lastKey = '';

/** Once at app start: read the backend settings, then load. Follows later changes in Settings. */
export async function startBackend(): Promise<void> {
  if (started) return;
  started = true;
  await loadReceiptUris();
  watchSettings();
  const cfg = await loadBackendConfig();
  lastKey = `${cfg.url}|${cfg.token}`;
  subscribeBackendConfig(() => {
    const c = getBackendConfig();
    const key = `${c.url}|${c.token}`;
    if (key === lastKey) return;
    lastKey = key;
    void applyMode();
  });
  await applyMode();
}

// -- saving changes ----------------------------------------------------------------------

/**
 * Sends one change to the backend after the screen already shows it. When
 * the backend is not set up this does nothing (sample data stays on the
 * phone). When the save fails, the change is undone (if nothing else changed
 * since) and the banner says what was not saved.
 */
export function persist<T>(
  label: string,
  before: FinanceDataset,
  call: () => Promise<T>,
  opts: { onSaved?: (result: T) => void; refreshAfter?: boolean } = {},
): Promise<T | null> {
  if (!isBackendReady()) return Promise.resolve(null);
  const after = getFinance();
  return call().then(
    (result) => {
      opts.onSaved?.(result);
      if (opts.refreshAfter) scheduleRefresh();
      return result;
    },
    (e: unknown) => {
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
