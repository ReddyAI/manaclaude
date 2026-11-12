import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';
import { readToken, writeToken } from './tokenStorage';

/**
 * Where the backend is and how to talk to it: the Worker URL (prefilled from
 * EXPO_PUBLIC_API_URL, which the deploy bakes into the web build) and the
 * APP_API_TOKEN you type in Settings, Backend. The URL is not secret and sits
 * in AsyncStorage; the token goes to tokenStorage (secure store on the phone,
 * browser storage on the web). When both are set the app uses your data;
 * otherwise it shows the sample data.
 */

export interface BackendConfig {
  url: string;
  token: string;
  loaded: boolean;
  /**
   * Names the backend these credentials select. A new random value is made
   * every time the URL or token changes (and when the token is forgotten), so
   * requests, saved copies and waiting changes made for one backend can be
   * told apart from another's. It is not derived from the token.
   */
  scope: string;
}

const URL_KEY = 'billionaire.backendUrl';
const SCOPE_KEY = 'billionaire.backendScope';

type Listener = () => void;
let config: BackendConfig = { url: defaultUrl(), token: '', loaded: false, scope: '' };
const listeners = new Set<Listener>();

function newScope(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

async function storeScope(scope: string): Promise<void> {
  try {
    await AsyncStorage.setItem(SCOPE_KEY, scope);
  } catch {
    // Without storage the scope lasts for this session, which only costs a fresh load next time.
  }
}

export function defaultUrl(): string {
  return normalizeUrl(process.env.EXPO_PUBLIC_API_URL ?? '');
}

/** Trims spaces and trailing slashes; adds https:// when the scheme is missing. */
export function normalizeUrl(raw: string): string {
  const text = raw.trim().replace(/\/+$/, '');
  if (!text) return '';
  return /^https?:\/\//i.test(text) ? text : `https://${text}`;
}

export function isValidUrl(raw: string): boolean {
  try {
    const url = new URL(normalizeUrl(raw));
    return (
      url.protocol === 'https:' || url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    );
  } catch {
    return false;
  }
}

function emit(): void {
  for (const l of listeners) l();
}

export function getBackendConfig(): BackendConfig {
  return config;
}

/** True when the app should load and save through the backend. */
export function isBackendReady(c: BackendConfig = config): boolean {
  return c.loaded && c.url !== '' && c.token !== '';
}

export async function loadBackendConfig(): Promise<BackendConfig> {
  let url = '';
  try {
    url = (await AsyncStorage.getItem(URL_KEY)) ?? '';
  } catch {
    url = '';
  }
  const token = (await readToken()) ?? '';
  let scope = '';
  try {
    scope = (await AsyncStorage.getItem(SCOPE_KEY)) ?? '';
  } catch {
    scope = '';
  }
  if (!scope) {
    scope = newScope();
    await storeScope(scope);
  }
  config = { url: normalizeUrl(url) || defaultUrl(), token, loaded: true, scope };
  emit();
  return config;
}

export async function saveBackendConfig(next: { url: string; token: string }): Promise<void> {
  const url = normalizeUrl(next.url);
  const token = next.token.trim();
  try {
    await AsyncStorage.setItem(URL_KEY, url);
  } catch {
    // Storage can fail in private browsing; the value still applies for this session.
  }
  await writeToken(token || null);
  const same = config.loaded && url === config.url && token === config.token && config.scope !== '';
  const scope = same ? config.scope : newScope();
  if (!same) await storeScope(scope);
  config = { url, token, loaded: true, scope };
  emit();
}

/** Forget the token (the URL stays). The app goes back to the sample data. */
export async function forgetBackendToken(): Promise<void> {
  const scope = newScope();
  // The new scope applies at once, so answers still on their way are dropped
  // even while the secure store is busy removing the token.
  config = { ...config, token: '', loaded: true, scope };
  emit();
  await Promise.all([writeToken(null), storeScope(scope)]);
}

/** Tests: set the config without storage. A changed URL or token gets a new scope, as in the app. */
export function setBackendConfigForTests(next: Partial<BackendConfig>): void {
  const merged = { ...config, loaded: true, ...next };
  const changed = merged.url !== config.url || merged.token !== config.token;
  config = {
    ...merged,
    scope: next.scope ?? (changed || !config.scope ? newScope() : config.scope),
  };
  emit();
}

export function subscribeBackendConfig(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBackendConfig(): BackendConfig {
  return useSyncExternalStore(subscribeBackendConfig, getBackendConfig, getBackendConfig);
}
