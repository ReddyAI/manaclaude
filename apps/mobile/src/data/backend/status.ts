import { useSyncExternalStore } from 'react';

/** What the backend loader is doing, for the banner and Settings, Backend. */
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

export function setBackendStatus(patch: Partial<BackendStatus>): void {
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
  setBackendStatus({ error: message });
}

export function dismissBackendError(): void {
  setBackendStatus({ error: null });
}
