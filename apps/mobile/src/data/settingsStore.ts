import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';
import { DEFAULT_SETTINGS, type Settings } from '@manaclaude/shared';
import { setHapticsEnabled } from '../design/haptics';

/**
 * App settings, saved on the device (AsyncStorage; localStorage on web).
 * Later the backend keeps a copy so the MCP server and AI jobs can read it.
 */

const STORAGE_KEY = 'mana.settings.v1';

type Listener = () => void;
let settings: Settings = DEFAULT_SETTINGS;
let loaded = false;
const listeners = new Set<Listener>();

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

export function updateSettings(patch: Partial<Settings>): void {
  settings = merge({ ...settings, ...patch });
  emit();
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(settings)).catch(() => {
    // Saving can fail in private browsing; the change still applies for this session.
  });
}

export function subscribeSettings(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSettings(): Settings {
  return useSyncExternalStore(subscribeSettings, getSettings, getSettings);
}
