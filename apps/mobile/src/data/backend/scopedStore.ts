import { useSyncExternalStore } from 'react';
import { errorText, isSuperseded, supersededError } from './client';
import { getBackendConfig, isBackendReady, subscribeBackendConfig } from './config';

/**
 * Something read straight from the Worker (not part of the dataset) and kept
 * in memory only, tied to the backend it came from. When the backend address
 * or token changes, or the token is forgotten, the value is dropped at once
 * and any answer still on its way for the old backend is thrown away.
 *
 * Writes go through `mutate`: the screen changes only after the Worker
 * confirmed, from what the Worker answered.
 */
export interface ScopedState<T> {
  /** null until a value has arrived from the selected backend. */
  value: T | null;
  loading: boolean;
  /** A plain sentence when the last load failed. */
  error: string | null;
}

export interface ScopedStore<T> {
  /** Loads the value. Calls made while one is on its way share it. */
  load(): Promise<void>;
  /**
   * Sends one write. When the Worker confirms, `apply` makes the new value
   * from the current one and the answer. Throws the request's error; throws a
   * superseded error when the backend changed meanwhile (nothing is applied).
   */
  mutate<R>(call: () => Promise<R>, apply: (value: T | null, result: R) => T | null): Promise<R>;
  get(): ScopedState<T>;
  use(): ScopedState<T>;
  /** Tests: forget everything. */
  reset(): void;
}

const EMPTY = { value: null, loading: false, error: null } as const;

export function createScopedStore<T>(fetcher: () => Promise<T>): ScopedStore<T> {
  let state: ScopedState<T> = EMPTY;
  let scope = '';
  let inFlight: Promise<void> | null = null;
  // Bumped by every confirmed write: a list asked for before it would undo it on screen.
  let version = 0;
  let watching = false;
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const l of listeners) l();
  };
  const set = (patch: Partial<ScopedState<T>>) => {
    state = { ...state, ...patch };
    emit();
  };
  /** Starts again for another backend. Nothing of the old one's value stays on screen. */
  const follow = () => {
    const current = getBackendConfig().scope;
    if (current === scope) return;
    scope = current;
    inFlight = null;
    version += 1;
    state = EMPTY;
    emit();
  };
  const watch = () => {
    if (watching) return;
    watching = true;
    subscribeBackendConfig(follow);
  };

  const store: ScopedStore<T> = {
    load() {
      watch();
      follow();
      if (!isBackendReady()) return Promise.resolve();
      if (inFlight) return inFlight;
      const asked = scope;
      const askedVersion = version;
      set({ loading: true, error: null });
      const run: Promise<void> = fetcher()
        .then(
          (value) => {
            if (asked !== scope) return;
            // A write was confirmed while this list was on its way: keep what is on screen.
            if (askedVersion !== version && state.value !== null) set({ loading: false });
            else set({ value, loading: false });
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
    },
    async mutate(call, apply) {
      watch();
      follow();
      const asked = scope;
      const result = await call();
      if (asked !== scope) throw supersededError();
      version += 1;
      set({ value: apply(state.value, result) });
      return result;
    },
    get: () => state,
    use() {
      return useSyncExternalStore(
        (l) => {
          watch();
          listeners.add(l);
          return () => listeners.delete(l);
        },
        () => state,
        () => state,
      );
    },
    reset() {
      state = EMPTY;
      scope = '';
      inFlight = null;
      version = 0;
    },
  };
  return store;
}
