import {
  ConnectorRepairNeededError,
  type Connection,
  type ConnectionStatus,
  type ConnectorContext,
  type FetchLike,
} from '@manaclaude/shared';
import {
  getAdapter,
  runConnectionSync as runAdapterSync,
  shouldRefreshValuation,
} from '@manaclaude/connectors';
import type { Env } from '../env';
import { selectAll, selectOne } from '../db/table';
import { connectionsTable } from '../db/tables';
import { badRequest, notFound } from '../util/errors';
import { nowIso } from '../util/ids';
import { applySyncResult, markConnectionError, type SyncSummary } from './apply';
import { loadCredentials, saveCredentials } from './credentials';
import { VALUATION_CONNECTORS, workerSecretsFor } from './secrets';

export type SyncOutcomeKind = 'ok' | 'needs_repair' | 'error' | 'skipped';

export interface ConnectionSyncReport {
  connectionId: string;
  connectorId: string;
  outcome: SyncOutcomeKind;
  /** Why nothing was fetched: the login needs repair, or a property value was refreshed under a month ago. */
  skippedBecause?: 'needs_repair' | 'valuation_recent';
  status: ConnectionStatus;
  /** Short message for the UI; never a provider payload. */
  error: string | null;
  summary: SyncSummary | null;
}

export interface SyncOptions {
  /** Replaces the global fetch for every provider call (tests). */
  fetch?: typeof fetch;
  now?: () => Date;
  /** Sync a connection that needs repair, or refresh a property value early. */
  force?: boolean;
}

/**
 * Teller wants the application's client certificate on every call, which the
 * Worker holds in the TELLER_CERT mTLS binding. Every other connector uses the
 * plain fetch. An injected fetch (tests) wins over both.
 */
export function fetchForConnector(env: Env, connectorId: string, injected?: typeof fetch) {
  if (injected) return injected;
  if (connectorId === 'teller' && env.TELLER_CERT) {
    const cert = env.TELLER_CERT;
    return ((input: RequestInfo | URL, init?: RequestInit) =>
      cert.fetch(input as never, init as never)) as typeof fetch;
  }
  // Not `return fetch`: workerd throws "Illegal invocation" when the global fetch is called as a method.
  return ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)) as typeof fetch;
}

/** Where a sync stops being worth a provider call. null = go ahead. */
export function skipReason(
  connection: Connection,
  now: Date,
  force: boolean,
): 'needs_repair' | 'valuation_recent' | null {
  if (force) return null;
  if (connection.status === 'needs_repair') return 'needs_repair';
  if (
    VALUATION_CONNECTORS.includes(connection.connectorId) &&
    !shouldRefreshValuation(connection.lastSuccessfulSyncAt, now)
  ) {
    return 'valuation_recent';
  }
  return null;
}

/**
 * Syncs one connection: reads its saved credentials, runs the adapter through
 * session D's runConnectionSync (which never throws and marks an expired login
 * needs_repair), saves any rotated credentials straight away (before anything
 * else can fail), then applies the plans to D1. Never throws for provider
 * trouble; the report says what happened. Throws only for an unknown id.
 */
export async function syncConnection(
  env: Env,
  connectionId: string,
  opts: SyncOptions = {},
): Promise<ConnectionSyncReport> {
  const connection = await selectOne(env.DB, connectionsTable, 'id = ?', [connectionId]);
  if (!connection) throw notFound('Connection not found.');
  const adapter = getAdapter(connection.connectorId);
  if (!adapter) throw badRequest(`No adapter for ${connection.connectorId} yet.`, 'no_adapter');
  const nowFn = opts.now ?? (() => new Date());
  const base = { connectionId, connectorId: connection.connectorId };

  const skipped = skipReason(connection, nowFn(), opts.force ?? false);
  if (skipped) {
    return {
      ...base,
      outcome: 'skipped',
      skippedBecause: skipped,
      status: connection.status,
      error: connection.lastError,
      summary: null,
    };
  }

  const now = nowIso(nowFn());
  try {
    const credentials = await loadCredentials(env, connection.id);
    const ctx: ConnectorContext = {
      // The app's own keys win over a same-named per-login value.
      secrets: { ...credentials, ...workerSecretsFor(env, connection.connectorId) },
      fetch: fetchForConnector(env, connection.connectorId, opts.fetch) as unknown as FetchLike,
      now: nowFn,
    };
    const outcome = await runAdapterSync(adapter, ctx, connection, { force: opts.force });
    const updated = outcome.result?.updatedSecrets;
    if (updated && Object.keys(updated).length > 0) {
      // A rotated token is the only copy; store it before any later step can fail.
      await saveCredentials(env, connection.id, updated);
    }
    if (!outcome.result) {
      const failed = outcome.connection;
      await markConnectionError(
        env.DB,
        connection,
        failed.status,
        failed.lastError ?? 'Sync failed.',
        now,
      );
      return {
        ...base,
        outcome: outcome.kind,
        status: failed.status,
        error: failed.lastError,
        summary: null,
      };
    }
    const summary = await applySyncResult(env.DB, connection, outcome.result, now);
    return { ...base, outcome: 'ok', status: 'healthy', error: null, summary };
  } catch (e) {
    const repair = e instanceof ConnectorRepairNeededError;
    const status: ConnectionStatus = repair ? 'needs_repair' : 'error';
    const message = e instanceof Error ? e.message : 'Sync failed.';
    await markConnectionError(env.DB, connection, status, message, now);
    return {
      ...base,
      outcome: repair ? 'needs_repair' : 'error',
      status,
      error: message.slice(0, 200),
      summary: null,
    };
  }
}

/**
 * The daily cron: every healthy connection is synced, one after another. A
 * connection that needs repair is skipped (a dead token is not called again),
 * and so is a disconnected one. A connection in error is tried again, since
 * most errors (rate limits, a provider outage) pass. One failure never stops
 * the rest.
 */
export async function syncAllConnections(
  env: Env,
  opts: SyncOptions = {},
): Promise<ConnectionSyncReport[]> {
  const connections = await selectAll(
    env.DB,
    connectionsTable,
    "status IN ('healthy', 'error')",
    [],
    'created_at',
  );
  const reports: ConnectionSyncReport[] = [];
  for (const c of connections) {
    try {
      reports.push(await syncConnection(env, c.id, opts));
    } catch (e) {
      console.error('Sync failed', c.connectorId, e instanceof Error ? e.message : String(e));
    }
  }
  return reports;
}
