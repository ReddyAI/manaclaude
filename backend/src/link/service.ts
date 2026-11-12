import {
  canAddFreeConnection,
  getAdapter,
  getConnector,
  slotStatus,
  LINK_ORDER,
} from '@manaclaude/connectors';
import type {
  Connection,
  ConnectorContext,
  FetchLike,
  LinkConnectorOption,
  LinkOptionsResponse,
} from '@manaclaude/shared';
import type { Env } from '../env';
import { insertStatement, selectOne } from '../db/table';
import { connectionsTable } from '../db/tables';
import { saveCredentials, type Credentials } from '../sync/credentials';
import { fetchForConnector } from '../sync/run';
import { WORKER_SECRETS_BY_CONNECTOR, workerSecretsFor } from '../sync/secrets';
import { ApiError, badRequest, conflict, notFound } from '../util/errors';
import { newId, nowIso } from '../util/ids';

/** Connectors the app can link in this version, in the order the Add account screen offers them. */
export const LINKABLE = [
  'sophtron',
  'simplefin',
  'plaid',
  'snaptrade',
  'zerodha_kite',
  'coinbase',
  'wazirx',
] as const;
export type LinkableConnector = (typeof LINKABLE)[number];

/** The Android package name registered with Plaid (app.json). */
export const ANDROID_PACKAGE = 'com.reddyai.manaclaude';
/** A fixed, non-personal id for the one person who uses the app. */
export const OWNER_CLIENT_ID = 'billionaire-owner';

export function plaidEnabled(env: Env): boolean {
  return env.PLAID_LINK_ENABLED === 'true';
}

/** Is every app-level secret this connector needs set? Answers yes or no, never a value. */
export function isConfigured(env: Env, connectorId: string): boolean {
  const needed = (WORKER_SECRETS_BY_CONNECTOR[connectorId] ?? []).filter((n) => n !== 'PLAID_ENV');
  const have = workerSecretsFor(env, connectorId);
  return needed.every((n) => n in have);
}

export function requireCredentialsSecret(env: Env): void {
  if (!env.CREDENTIALS_SECRET)
    throw new ApiError(
      503,
      'not_configured',
      'CREDENTIALS_SECRET is not set, so logins cannot be saved. Add it as a GitHub secret and run the deploy again.',
    );
}

export function requireConfigured(env: Env, connectorId: string): void {
  requireCredentialsSecret(env);
  if (!isConfigured(env, connectorId)) {
    const names = (WORKER_SECRETS_BY_CONNECTOR[connectorId] ?? []).filter((n) => n !== 'PLAID_ENV');
    throw new ApiError(
      503,
      'not_configured',
      `${getConnector(connectorId)?.name ?? connectorId} is not set up yet: add ${names.join(' and ')} as GitHub secrets and run the deploy again.`,
    );
  }
}

export async function slotLedger(db: D1Database): Promise<Record<string, number>> {
  const res = await db
    .prepare('SELECT connector_id, used FROM connector_slots')
    .all<{ connector_id: string; used: number }>();
  return Object.fromEntries(res.results.map((r) => [r.connector_id, r.used]));
}

/** Refuses a new login when the connector is unavailable or out of free slots. */
export async function assertCanLink(db: D1Database, connectorId: string, count = 1): Promise<void> {
  const def = getConnector(connectorId);
  if (!def || !(LINKABLE as readonly string[]).includes(connectorId))
    throw notFound('This connector cannot be linked from the app.');
  if (def.availability === 'unavailable')
    throw conflict(def.reason ?? `${def.name} is not available.`, 'unavailable');
  if (def.availability !== 'available') return;
  const ledger = await slotLedger(db);
  const status = slotStatus(def, ledger);
  if (!canAddFreeConnection(def, ledger) || (status.left !== null && status.left < count)) {
    throw conflict(
      `No free ${def.name} ${def.slotsAreLifetime ? 'logins' : 'connections'} left (${status.used} of ${status.total} used).`,
      'no_slots',
    );
  }
}

export async function linkOptions(env: Env): Promise<LinkOptionsResponse> {
  const ledger = await slotLedger(env.DB);
  const connectors: LinkConnectorOption[] = LINKABLE.map((id) => {
    const def = getConnector(id)!;
    const slots = slotStatus(def, ledger);
    const configured =
      id === 'plaid' ? isConfigured(env, id) && plaidEnabled(env) : isConfigured(env, id);
    let blockedReason: string | null = null;
    if (def.availability === 'unavailable') blockedReason = def.reason;
    else if (id === 'plaid' && !plaidEnabled(env))
      blockedReason = 'Plaid is off until you say so. Nothing is sent to Plaid.';
    else if (!isConfigured(env, id))
      blockedReason = `Not set up yet: add ${(WORKER_SECRETS_BY_CONNECTOR[id] ?? []).filter((n) => n !== 'PLAID_ENV').join(' and ')} as GitHub secrets.`;
    else if (slots.exhausted) blockedReason = 'No free slots left.';
    return {
      id,
      name: def.name,
      configured,
      blockedReason,
      slots: { total: slots.total, used: slots.used, left: slots.left, lifetime: slots.lifetime },
    };
  });
  const usable = (ids: readonly string[]) =>
    ids.filter(
      (id) =>
        (LINKABLE as readonly string[]).includes(id) &&
        getConnector(id)?.availability !== 'unavailable',
    );
  return {
    order: {
      bank: usable(LINK_ORDER.bank),
      brokerage: usable(LINK_ORDER.brokerage),
      crypto: usable(LINK_ORDER.crypto),
    },
    connectors,
    plaidEnabled: plaidEnabled(env),
    credentialsReady: Boolean(env.CREDENTIALS_SECRET),
  };
}

/** The context link helpers run in: this connector's Worker secrets, plus anything extra. */
export function linkContext(
  env: Env,
  connectorId: string,
  injectedFetch: typeof fetch | undefined,
  extra: Record<string, string> = {},
  now: () => Date = () => new Date(),
): ConnectorContext {
  return {
    secrets: { ...extra, ...workerSecretsFor(env, connectorId) },
    fetch: fetchForConnector(env, connectorId, injectedFetch) as unknown as FetchLike,
    now,
  };
}

export async function loadConnectionFor(
  db: D1Database,
  connectionId: string,
  connectorId: string,
): Promise<Connection> {
  const c = await selectOne(db, connectionsTable, 'id = ?', [connectionId]);
  if (!c || c.connectorId !== connectorId) throw notFound('Connection not found.');
  return c;
}

/**
 * Saves a finished login. A repair (connectionId) keeps the connection, its
 * accounts and history, merges the new credentials over the old ones and uses
 * no slot. A new login checks the free slots, stores the credentials first
 * (so a connection never exists without them), then adds the connection and
 * counts the slot. Either way the connection is left as "syncing": the app's
 * next sync call, or the five-minute cron, fetches its data.
 */
export async function finishLink(
  env: Env,
  input: {
    connectorId: string;
    institutionName: string;
    credentials: Credentials;
    connectionId?: string | null;
    now?: Date;
  },
): Promise<{ connectionId: string; repaired: boolean }> {
  const now = nowIso(input.now);
  if (input.connectionId) {
    const c = await loadConnectionFor(env.DB, input.connectionId, input.connectorId);
    await saveCredentials(env, c.id, input.credentials);
    await env.DB.prepare(
      "UPDATE connections SET status = 'syncing', last_error = NULL, updated_at = ? WHERE id = ?",
    )
      .bind(now, c.id)
      .run();
    return { connectionId: c.id, repaired: true };
  }
  await assertCanLink(env.DB, input.connectorId);
  const connection: Connection = {
    id: newId('conn'),
    connectorId: input.connectorId,
    institutionName:
      input.institutionName.slice(0, 120) || getConnector(input.connectorId)?.name || 'Bank',
    status: 'syncing',
    lastSyncAt: null,
    lastSuccessfulSyncAt: null,
    lastError: null,
    syncCursor: null,
    accountIds: [],
    createdAt: now,
    updatedAt: now,
  };
  await saveCredentials(env, connection.id, input.credentials, { replace: true });
  await env.DB.batch([
    insertStatement(env.DB, connectionsTable, connection),
    env.DB.prepare(
      'INSERT INTO connector_slots (connector_id, used) VALUES (?, 1) ON CONFLICT (connector_id) DO UPDATE SET used = used + 1',
    ).bind(input.connectorId),
  ]);
  return { connectionId: connection.id, repaired: false };
}

/** Marks a repaired connection ready to sync, when the login itself did not change (Plaid update mode, a Sophtron question answered). */
export async function markRepaired(
  env: Env,
  connectionId: string,
  connectorId: string,
  now = new Date(),
) {
  const c = await loadConnectionFor(env.DB, connectionId, connectorId);
  await env.DB.prepare(
    "UPDATE connections SET status = 'syncing', last_error = NULL, updated_at = ? WHERE id = ?",
  )
    .bind(nowIso(now), c.id)
    .run();
  return { connectionId: c.id, repaired: true };
}

/** Checks an exchange key pair with the adapter's cheap health call. */
export async function checkKeys(
  env: Env,
  connectorId: 'coinbase' | 'wazirx',
  secrets: Record<string, string>,
  injectedFetch: typeof fetch | undefined,
  now: () => Date = () => new Date(),
): Promise<void> {
  const adapter = getAdapter(connectorId);
  if (!adapter?.checkHealth) return;
  const timestamp = nowIso(now());
  const probe: Connection = {
    id: 'conn_probe',
    connectorId,
    institutionName: connectorId,
    status: 'healthy',
    lastSyncAt: null,
    lastSuccessfulSyncAt: null,
    lastError: null,
    syncCursor: null,
    accountIds: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const status = await adapter.checkHealth(
    linkContext(env, connectorId, injectedFetch, secrets, now),
    probe,
  );
  const name = getConnector(connectorId)?.name ?? connectorId;
  if (status === 'needs_repair')
    throw badRequest(
      `${name} did not accept this key. Make a read-only key and paste both parts again.`,
      'link_input',
    );
  if (status !== 'healthy')
    throw new ApiError(
      502,
      'provider_error',
      `Could not check the key with ${name}. Check that you pasted all of it, then try again.`,
    );
}
