import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';
import { DEFAULT_SETTINGS, type Settings } from '@manaclaude/shared';
import { setHapticsEnabled } from '../design/haptics';

/**
 * App settings, saved on the device (AsyncStorage; localStorage on web).
 * The backend keeps its own copy of some of them (data/backend/settingsSync.ts)
 * so the MCP server and AI jobs can read it.
 *
 * Two ways in, kept apart on purpose:
 * - `updateSettings` is a change you made. Change listeners hear about it.
 * - `applyBackendSettings` is the backend's copy arriving. The screen updates,
 *   but change listeners stay silent, so it is never sent back as if you had
 *   chosen it.
 */

const STORAGE_KEY = 'mana.settings.v1';

type Listener = () => void;
let settings: Settings = DEFAULT_SETTINGS;
let loaded = false;
const listeners = new Set<Listener>();
type ChangeListener = (prev: Settings, next: Settings) => void;
const changeListeners = new Set<ChangeListener>();

function emit(): void {
  setHapticsEnabled(settings.hapticsEnabled);
  for (const l of listeners) l();
}

export function getSettings(): Settings {
  return settings;
}

export function isSettingsLoaded(): boolean {
  return loaded;
}

function merge(saved: Partial<Settings> | null): Settings {
  if (!saved) return DEFAULT_SETTINGS;
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    moneyPolicies: { ...DEFAULT_SETTINGS.moneyPolicies, ...(saved.moneyPolicies ?? {}) },
  };
}

/** Load once at startup, before the splash screen hides. */
export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    settings = merge(raw ? (JSON.parse(raw) as Partial<Settings>) : null);
  } catch {
    settings = DEFAULT_SETTINGS;
  }
  loaded = true;
  emit();
  return settings;
}

function save(): void {
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(settings)).catch(() => {
    // Saving can fail in private browsing; the change still applies for this session.
  });
}

/** A change made by the person using the app. */
export function updateSettings(patch: Partial<Settings>): void {
  const prev = settings;
  settings = merge({ ...settings, ...patch });
  emit();
  save();
  for (const l of changeListeners) l(prev, settings);
}

/** The backend's values for some settings. Shown and saved here; not reported as a change. */
export function applyBackendSettings(values: Partial<Settings>): void {
  settings = merge({ ...settings, ...values });
  emit();
  save();
}

/** Hears only changes made through `updateSettings`, with the settings before and after. */
export function subscribeSettingChanges(listener: ChangeListener): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

export function subscribeSettings(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSettings(): Settings {
  return useSyncExternalStore(subscribeSettings, getSettings, getSettings);
}
