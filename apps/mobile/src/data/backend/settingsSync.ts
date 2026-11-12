import AsyncStorage from '@react-native-async-storage/async-storage';
import type { MoneyPolicies, Settings } from '@manaclaude/shared';
import { applyBackendSettings, getSettings, subscribeSettingChanges } from '../settingsStore';
import { api, errorText, isSuperseded } from './client';
import { getBackendConfig, isBackendReady } from './config';
import { reportBackendError } from './status';

/**
 * Keeps the settings the Worker reads (AI switch, MCP write tools, money
 * policies and the rest of SERVER_SETTINGS) in step with the backend.
 *
 * The rules:
 * 1. The backend's copy is loaded first. Nothing is sent to a backend until
 *    its settings have arrived on this device in this session.
 * 2. Only what you changed is sent: the one field, or the one money policy.
 *    Fields you did not touch are never sent, so a new phone cannot replace
 *    the backend's choices with its own defaults.
 * 3. For a field you did not change, the backend's value wins on every load.
 *    For a field you changed, your change wins: it waits (through a failed
 *    send, being offline or an app restart) until the backend has taken it.
 * 4. Waiting changes belong to one backend. Changing the URL or token, or
 *    forgetting the token, drops them.
 */
export const SERVER_SETTINGS = [
  'displayCurrencyMode',
  'primaryCurrency',
  'secondaryCurrency',
  'aiEnabled',
  'aiProvider',
  'look',
  'colorScheme',
  'hapticsEnabled',
  'dashboardLayout',
  'moneyPolicies',
  'mcpWriteToolsEnabled',
  'weekStartsOn',
] as const;

type ServerKey = (typeof SERVER_SETTINGS)[number];
type PlainKey = Exclude<ServerKey, 'moneyPolicies'>;

/** Changed fields only; `moneyPolicies` holds just the policies that changed. */
export type SettingsPatch = { [K in PlainKey]?: Settings[K] } & {
  moneyPolicies?: Partial<MoneyPolicies>;
};

const PENDING_KEY = 'billionaire.pendingSettings';
const SEND_DELAY_MS = 600;

/** Changes made here that the backend has not confirmed yet, and which backend they are for. */
let waiting: { scope: string; patch: SettingsPatch } | null = null;
/** The backend whose settings have been loaded in this session; sending is allowed only for it. */
let loadedScope: string | null = null;
/** Goes up each time the backend confirms a change, so an older dataset answer is not applied over it. */
let confirmed = 0;
let sending = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let watching = false;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isEmpty = (patch: SettingsPatch) => Object.keys(patch).length === 0;

/** The server-backed fields that differ between two settings objects. */
export function settingsDiff(prev: Settings, next: Settings): SettingsPatch {
  const patch: Record<string, unknown> = {};
  for (const key of SERVER_SETTINGS) {
    if (key === 'moneyPolicies') {
      const changed = Object.fromEntries(
        (Object.keys(next.moneyPolicies) as (keyof MoneyPolicies)[])
          .filter((k) => prev.moneyPolicies[k] !== next.moneyPolicies[k])
          .map((k) => [k, next.moneyPolicies[k]]),
      );
      if (Object.keys(changed).length > 0) patch.moneyPolicies = changed;
    } else if (!same(prev[key], next[key])) patch[key] = next[key];
  }
  return patch as SettingsPatch;
}

function combine(base: SettingsPatch, more: SettingsPatch): SettingsPatch {
  const out: SettingsPatch = { ...base, ...more };
  if (base.moneyPolicies || more.moneyPolicies)
    out.moneyPolicies = { ...base.moneyPolicies, ...more.moneyPolicies };
  return out;
}

/** What is left of `patch` after the backend took `sent`: fields changed again since stay. */
function without(patch: SettingsPatch, sent: SettingsPatch): SettingsPatch {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'moneyPolicies') {
      const sentPolicies = (sent.moneyPolicies ?? {}) as Record<string, unknown>;
      const left = Object.fromEntries(
        Object.entries(value as object).filter(([k, v]) => sentPolicies[k] !== v),
      );
      if (Object.keys(left).length > 0) out.moneyPolicies = left;
    } else if (!same((sent as Record<string, unknown>)[key], value)) out[key] = value;
  }
  return out as SettingsPatch;
}

function storeWaiting(): void {
  const task =
    waiting && !isEmpty(waiting.patch)
      ? AsyncStorage.setItem(PENDING_KEY, JSON.stringify(waiting))
      : AsyncStorage.removeItem(PENDING_KEY);
  task.catch(() => {
    // Without storage a waiting change lasts until the app closes.
  });
}

/** App start: bring back changes that were still waiting when the app last closed. */
export async function loadWaitingSettings(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_KEY);
    const saved = raw ? (JSON.parse(raw) as { scope?: string; patch?: SettingsPatch }) : null;
    if (!saved?.scope || !saved.patch || waiting) return;
    // Only fields this version still sends, in case the saved copy is older.
    const patch = Object.fromEntries(
      Object.entries(saved.patch).filter(([k]) =>
        (SERVER_SETTINGS as readonly string[]).includes(k),
      ),
    ) as SettingsPatch;
    if (!isEmpty(patch)) waiting = { scope: saved.scope, patch };
  } catch {
    // An unreadable copy is the same as none.
  }
}

/** The backend changed or was forgotten: nothing made for the old one may be sent to the new one. */
export function resetSettingsSync(scope: string): void {
  if (timer) clearTimeout(timer);
  timer = null;
  loadedScope = null;
  if (waiting && waiting.scope !== scope) {
    waiting = null;
    storeWaiting();
  }
}

/** A marker to pass back to `applyLoadedSettings`, taken when a dataset request starts. */
export function settingsMarker(): number {
  return confirmed;
}

/**
 * The backend's settings arrived (with the dataset, or as the answer to a
 * save). Shows them, except fields with a change still waiting, then sends
 * what is waiting. `marker` is from `settingsMarker()` when the request began;
 * if a change was confirmed since, that answer is older and only unlocks
 * sending.
 */
export function applyLoadedSettings(
  server: Partial<Settings> | null | undefined,
  scope: string,
  marker = confirmed,
): void {
  if (scope !== getBackendConfig().scope) return;
  if (server && marker === confirmed) show(server, scope);
  loadedScope = scope;
  schedule(0);
}

function show(server: Partial<Settings>, scope: string): void {
  const mine = waiting?.scope === scope ? waiting.patch : {};
  const values: Record<string, unknown> = {};
  for (const key of SERVER_SETTINGS) {
    if (server[key] === undefined) continue;
    if (key === 'moneyPolicies') values[key] = { ...server.moneyPolicies, ...mine.moneyPolicies };
    else values[key] = key in mine ? mine[key] : server[key];
  }
  // Skip the write when nothing differs, so screens do not re-render on every reload.
  const current = getSettings() as unknown as Record<string, unknown>;
  const differs = Object.entries(values).some(([k, v]) =>
    k === 'moneyPolicies'
      ? !same({ ...(current[k] as object), ...(v as object) }, current[k])
      : !same(v, current[k]),
  );
  if (differs) applyBackendSettings(values as Partial<Settings>);
}

function schedule(delayMs: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void send();
  }, delayMs);
}

async function send(): Promise<void> {
  const scope = getBackendConfig().scope;
  if (sending || !waiting || waiting.scope !== scope || isEmpty(waiting.patch)) return;
  if (!isBackendReady() || loadedScope !== scope) return;
  const patch = waiting.patch;
  sending = true;
  try {
    const saved = await api<Settings>('PATCH', '/v1/settings', patch);
    if (getBackendConfig().scope !== scope) return;
    confirmed += 1;
    if (waiting?.scope === scope) {
      const left = without(waiting.patch, patch);
      waiting = isEmpty(left) ? null : { scope, patch: left };
      storeWaiting();
    }
    if (saved) show(saved, scope);
  } catch (e) {
    if (isSuperseded(e) || getBackendConfig().scope !== scope) return;
    reportBackendError(
      `Settings not saved on the backend yet. ${errorText(e)} Your change is kept and sent again at the next reload.`,
    );
    return;
  } finally {
    sending = false;
  }
  if (waiting && waiting.scope === scope && !isEmpty(waiting.patch)) schedule(SEND_DELAY_MS);
}

/** Start listening for changes made in the app. Safe to call more than once. */
export function watchSettingChanges(): void {
  if (watching) return;
  watching = true;
  subscribeSettingChanges((prev, next) => {
    // Without a backend the change stays on this device only.
    if (!isBackendReady()) return;
    const patch = settingsDiff(prev, next);
    if (isEmpty(patch)) return;
    const scope = getBackendConfig().scope;
    waiting = { scope, patch: combine(waiting?.scope === scope ? waiting.patch : {}, patch) };
    storeWaiting();
    schedule(SEND_DELAY_MS);
  });
}

/** Tests: send what is waiting now, without the short delay. */
export function sendWaitingSettingsForTests(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  return send();
}

/** Tests: what is waiting to be sent. */
export function waitingSettingsForTests(): SettingsPatch | null {
  return waiting?.patch ?? null;
}

/** Tests: forget everything, as on a newly installed app. */
export function resetSettingsSyncForTests(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  waiting = null;
  loadedScope = null;
  sending = false;
}
