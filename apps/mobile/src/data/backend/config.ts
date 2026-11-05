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
}

const URL_KEY = 'billionaire.backendUrl';

type Listener = () => void;
let config: BackendConfig = { url: defaultUrl(), token: '', loaded: false };
const listeners = new Set<Listener>();

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
  config = { url: normalizeUrl(url) || defaultUrl(), token, loaded: true };
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
  config = { url, token, loaded: true };
  emit();
}

/** Forget the token (the URL stays). The app goes back to the sample data. */
export async function forgetBackendToken(): Promise<void> {
  await writeToken(null);
  config = { ...config, token: '', loaded: true };
  emit();
}

/** Tests: set the config without storage. */
export function setBackendConfigForTests(next: Partial<BackendConfig>): void {
  config = { ...config, loaded: true, ...next };
  emit();
}

export function subscribeBackendConfig(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBackendConfig(): BackendConfig {
  return useSyncExternalStore(subscribeBackendConfig, getBackendConfig, getBackendConfig);
}
