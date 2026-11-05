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
import { meterDb, QueryBudget, type MeteredDb } from '../db/meter';
import { applySyncResult, markConnectionError, type SyncSummary } from './apply';
import { loadCredentials, saveCredentials } from './credentials';
import { VALUATION_CONNECTORS, workerSecretsFor } from './secrets';

export type SyncOutcomeKind = 'ok' | 'needs_repair' | 'error' | 'skipped';

export interface ConnectionSyncReport {
  connectionId: string;
  connectorId: string;
  outcome: SyncOutcomeKind;
  /** A long first sync wrote part of its rows; call sync again (the app does, and so does the cron). */
  more: boolean;
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
  /**
   * D1 queries this sync may spend (Workers Free plan: about 50 per invocation).
   * Default SYNC_QUERY_BUDGET. Pass a shared meter to split one invocation's
   * allowance between several syncs.
   */
  maxQueries?: number;
  meter?: MeteredDb;
  /** Most new rows written per call (default MAX_ROWS_PER_SYNC in apply.ts). */
  maxRows?: number;
}

/** What one sync may spend of the ~50 D1 queries a Free-plan invocation allows, leaving room for the request around it. */
export const SYNC_QUERY_BUDGET = 44;
/** A sync is not started unless at least this many queries are left (reads, writes and the after-sync steps). */
export const MIN_QUERIES_TO_START = 20;

/**
 * The fetch every provider call goes through. An injected fetch (tests) wins.
 * (Teller's mTLS binding used to be chosen here; Teller shut down its API in July 2026.)
 */
export function fetchForConnector(_env: Env, _connectorId: string, injected?: typeof fetch) {
  if (injected) return injected;
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
  const meter = opts.meter ?? meterDb(env.DB);
  const budget = new QueryBudget(meter, opts.maxQueries ?? SYNC_QUERY_BUDGET);
  env = { ...env, DB: meter.db };
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
      more: false,
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
        more: false,
        status: failed.status,
        error: failed.lastError,
        summary: null,
      };
    }
    const summary = await applySyncResult(env.DB, connection, outcome.result, now, {
      budget,
      maxRows: opts.maxRows,
    });
    return {
      ...base,
      outcome: 'ok',
      more: summary.more,
      status: summary.more ? 'syncing' : 'healthy',
      error: null,
      summary,
    };
  } catch (e) {
    const repair = e instanceof ConnectorRepairNeededError;
    const status: ConnectionStatus = repair ? 'needs_repair' : 'error';
    const message = e instanceof Error ? e.message : 'Sync failed.';
    await markConnectionError(env.DB, connection, status, message, now);
    return {
      ...base,
      outcome: repair ? 'needs_repair' : 'error',
      more: false,
      status,
      error: message.slice(0, 200),
      summary: null,
    };
  }
}

/**
 * Syncs every healthy, errored or unfinished ("syncing") connection, one after
 * another, sharing one invocation's D1 allowance: it stops starting new syncs
 * when fewer than MIN_QUERIES_TO_START queries are left, and the five-minute
 * cron picks up the rest. A connection that needs repair is skipped (a dead
 * token is not called again), and so is a disconnected one. A connection in
 * error is tried again, since most errors (rate limits, an outage) pass. One
 * failure never stops the rest.
 */
export async function syncAllConnections(
  env: Env,
  opts: SyncOptions & { only?: (c: Connection) => boolean; totalQueries?: number } = {},
): Promise<ConnectionSyncReport[]> {
  const meter = opts.meter ?? meterDb(env.DB);
  const total = opts.totalQueries ?? SYNC_QUERY_BUDGET;
  const connections = await selectAll(
    meter.db,
    connectionsTable,
    "status IN ('syncing', 'healthy', 'error')",
    [],
    "CASE status WHEN 'syncing' THEN 0 ELSE 1 END, created_at",
  );
  const reports: ConnectionSyncReport[] = [];
  for (const c of connections) {
    if (opts.only && !opts.only(c)) continue;
    if (total - meter.used() < MIN_QUERIES_TO_START) break;
    try {
      reports.push(await syncConnection(env, c.id, { ...opts, meter, maxQueries: total }));
    } catch (e) {
      console.error('Sync failed', c.connectorId, e instanceof Error ? e.message : String(e));
    }
  }
  return reports;
}

/** The daily sync boundary: 06:30 UTC, the old daily cron time. */
export function lastDailyBoundary(now: Date): Date {
  const b = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 6, 30));
  if (b.getTime() > now.getTime()) b.setUTCDate(b.getUTCDate() - 1);
  return b;
}

/**
 * The five-minute cron. First it continues long first syncs (status
 * "syncing"), then it syncs connections not synced since the last 06:30 UTC
 * boundary, as many as one invocation's D1 allowance takes. So every
 * connection still syncs once a day, but never all in one invocation, and a
 * first sync with years of history finishes even if the app is closed.
 */
export async function syncDueConnections(
  env: Env,
  opts: SyncOptions = {},
): Promise<ConnectionSyncReport[]> {
  const now = (opts.now ?? (() => new Date()))();
  const boundary = lastDailyBoundary(now).toISOString();
  return syncAllConnections(env, {
    ...opts,
    only: (c) => c.status === 'syncing' || c.lastSyncAt === null || c.lastSyncAt < boundary,
  });
}
