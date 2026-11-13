import type { Alert } from '@manaclaude/shared';
import { useSyncExternalStore } from 'react';
import { errorText, isSuperseded } from '../../data/backend/client';
import {
  getBackendConfig,
  isBackendReady,
  subscribeBackendConfig,
} from '../../data/backend/config';
import { dismissAlert, listAlerts } from './alertsApi';

/**
 * The alerts of the selected backend, shared by the Home row and the Alerts
 * screen so a dismissal shows in both at once. Alerts are read straight from
 * the Worker (they are not part of the dataset) and are never stored on the
 * device. Everything here is dropped when the backend changes.
 */
export interface AlertsState {
  /** null until a list has arrived from this backend. */
  alerts: Alert[] | null;
  loading: boolean;
  /** A plain sentence when the list could not be loaded or a dismissal failed. */
  error: string | null;
  /** Alerts whose dismissal is on its way. */
  dismissing: readonly string[];
}

const EMPTY: AlertsState = { alerts: null, loading: false, error: null, dismissing: [] };

type Listener = () => void;
let state: AlertsState = EMPTY;
/** The backend `state` belongs to. */
let scope = '';
/** Dismissed on this backend in this session: a list that was asked for earlier must not bring them back. */
let dismissed = new Set<string>();
let inFlight: Promise<void> | null = null;
const listeners = new Set<Listener>();
let watching = false;

function set(patch: Partial<AlertsState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

/** Starts again for another backend. Nothing of the old one's alerts stays on screen. */
function follow(): void {
  const current = getBackendConfig().scope;
  if (current === scope) return;
  scope = current;
  dismissed = new Set();
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
export function loadAlerts(): Promise<void> {
  watch();
  follow();
  if (!isBackendReady()) return Promise.resolve();
  if (inFlight) return inFlight;
  const asked = scope;
  set({ loading: true, error: null });
  const run: Promise<void> = listAlerts()
    .then(
      (alerts) => {
        if (asked !== scope) return;
        set({ alerts: alerts.filter((a) => !dismissed.has(a.id)), loading: false });
      },
      (e: unknown) => {
        // The backend changed under the request: its state was already reset.
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

/**
 * Dismisses one alert. It leaves the list only after the Worker confirmed;
 * if the Worker cannot be reached it stays, with the reason.
 */
export async function dismiss(id: string): Promise<boolean> {
  watch();
  follow();
  if (state.dismissing.includes(id)) return false;
  const asked = scope;
  set({ dismissing: [...state.dismissing, id], error: null });
  try {
    await dismissAlert(id);
    if (asked !== scope) return false;
    dismissed.add(id);
    set({
      alerts: state.alerts?.filter((a) => a.id !== id) ?? null,
      dismissing: state.dismissing.filter((d) => d !== id),
    });
    return true;
  } catch (e) {
    if (asked !== scope || isSuperseded(e)) return false;
    set({ dismissing: state.dismissing.filter((d) => d !== id), error: errorText(e) });
    return false;
  }
}

export function getAlertsState(): AlertsState {
  return state;
}

function subscribe(listener: Listener): () => void {
  watch();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAlerts(): AlertsState {
  return useSyncExternalStore(subscribe, getAlertsState, getAlertsState);
}

/** Tests: forget everything. */
export function resetAlertsForTests(): void {
  state = EMPTY;
  scope = '';
  dismissed = new Set();
  inFlight = null;
}
