import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ManualAccountRequest, ManualAccountType } from '@manaclaude/shared';
import { getBackendConfig } from '../../data/backend/config';

/**
 * An account made by hand from the Accounts tab (POST /v1/accounts/manual):
 * a house, a car, a loan, an NRE or NRO account, anything with no
 * connector. The whole request, creation key included, is kept until the
 * Worker's answer is seen, so "Try again" sends exactly the same thing and
 * gets the same account back instead of a second one. It is tied to the
 * backend it was sent to and survives closing the app. The import flow keeps
 * its own, separate request (a new account there also becomes the file's
 * destination).
 */
const KEY = 'billionaire.pendingAccountByHand';

/** Offered here, first one chosen. Cash has its own form; everything else the Worker takes. */
export const BY_HAND_TYPES: readonly ManualAccountType[] = [
  'property',
  'vehicle',
  'other_asset',
  'savings',
  'checking',
  'credit_card',
  'loan',
  'mortgage',
  'other_liability',
  'brokerage',
  'retirement',
  'crypto',
];

export async function rememberByHand(request: ManualAccountRequest): Promise<void> {
  const value = { scope: getBackendConfig().scope, request };
  await AsyncStorage.setItem(KEY, JSON.stringify(value)).catch(() => {});
}

export async function clearByHand(): Promise<void> {
  await AsyncStorage.removeItem(KEY).catch(() => {});
}

export async function readByHand(): Promise<ManualAccountRequest | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as { scope?: string; request?: ManualAccountRequest };
    if (!saved.request?.idempotencyKey || saved.scope !== getBackendConfig().scope) return null;
    return saved.request;
  } catch {
    return null;
  }
}

/** What the sheet does with an error from the route. */
export type ByHandOutcome =
  /** No answer, or the Worker failed part way: it may exist. Keep the request; offer the same one again. */
  | 'unsure'
  /** 409: the key is tied to other details, or its account is gone. Never resend, never swap the key unseen. */
  | 'conflict'
  /** Refused outright (bad details, wrong token, no such route): nothing was made. */
  | 'refused';

export function byHandOutcome(status: number): ByHandOutcome {
  if (status === 0 || status >= 500) return 'unsure';
  if (status === 409) return 'conflict';
  return 'refused';
}
