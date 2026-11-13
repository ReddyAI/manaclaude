import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ManualAccountRequest } from '@manaclaude/shared';
import { getBackendConfig } from '../../data/backend/config';

/**
 * The one account whose creation was sent but whose outcome this phone has
 * not seen. The whole original request is kept, key and timestamps included,
 * so "Try again" sends exactly the same thing and the Worker answers with
 * the same account instead of making a second one. It is tied to the
 * backend it was sent to, and survives closing the app.
 */
const KEY = 'billionaire.pendingManualAccount';

export interface PendingAccount {
  request: ManualAccountRequest;
  /** The account named in the file this was being made for; null for a file with one destination. */
  source: string | null;
}

export async function rememberPendingAccount(pending: PendingAccount): Promise<void> {
  const value = { scope: getBackendConfig().scope, ...pending };
  await AsyncStorage.setItem(KEY, JSON.stringify(value)).catch(() => {});
}

export async function clearPendingAccount(): Promise<void> {
  await AsyncStorage.removeItem(KEY).catch(() => {});
}

export async function readPendingAccount(): Promise<PendingAccount | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Partial<PendingAccount> & { scope?: string };
    if (!saved.request?.idempotencyKey || saved.scope !== getBackendConfig().scope) return null;
    return { request: saved.request, source: saved.source ?? null };
  } catch {
    return null;
  }
}

/** A new key for one account being created: a random UUID, within the letters the Worker accepts. */
export function newCreationKey(): string {
  const native = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID;
  if (native) {
    try {
      return native.call((globalThis as { crypto?: unknown }).crypto);
    } catch {
      // Fall through to the plain version.
    }
  }
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[Math.floor(Math.random() * 4)]}${hex(3)}-${hex(12)}`;
}
