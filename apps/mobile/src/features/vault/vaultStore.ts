import type { ImportRecord } from '@manaclaude/shared';
import { useSyncExternalStore } from 'react';
import { errorText, isSuperseded } from '../../data/backend/client';
import {
  getBackendConfig,
  isBackendReady,
  subscribeBackendConfig,
} from '../../data/backend/config';
import { listVault } from './vaultApi';

/**
 * The list of stored files of the selected backend, shared by the list and
 * the page of one file. Kept in memory only, and dropped when the backend
 * changes.
 */
export interface VaultState {
  /** null until a list has arrived from this backend. */
  records: ImportRecord[] | null;
  loading: boolean;
  error: string | null;
}

const EMPTY: VaultState = { records: null, loading: false, error: null };

type Listener = () => void;
let state: VaultState = EMPTY;
let scope = '';
let inFlight: Promise<void> | null = null;
const listeners = new Set<Listener>();
let watching = false;

function set(patch: Partial<VaultState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function follow(): void {
  const current = getBackendConfig().scope;
  if (current === scope) return;
  scope = current;
  inFlight = null;
  state = EMPTY;
  for (const l of listeners) l();
}

function watch(): void {
  if (watching) return;
  watching = true;
  subscribeBackendConfig(follow);
}

/** Loads the list. Calls made while one is on its way share it. */
export function loadVault(): Promise<void> {
  watch();
  follow();
  if (!isBackendReady()) return Promise.resolve();
  if (inFlight) return inFlight;
  const asked = scope;
  set({ loading: true, error: null });
  const run: Promise<void> = listVault()
    .then(
      (records) => {
        if (asked === scope) set({ records, loading: false });
      },
      (e: unknown) => {
        if (asked !== scope || isSuperseded(e)) return;
        set({ loading: false, error: errorText(e) });
      },
    )
    .finally(() => {
      if (inFlight === run) inFlight = null;
    });
  inFlight = run;
  return run;
}

export function getVaultState(): VaultState {
  return state;
}

function subscribe(listener: Listener): () => void {
  watch();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useVault(): VaultState {
  return useSyncExternalStore(subscribe, getVaultState, getVaultState);
}

/** Tests: forget everything. */
export function resetVaultForTests(): void {
  state = EMPTY;
  scope = '';
  inFlight = null;
}
