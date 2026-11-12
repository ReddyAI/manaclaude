import type {
  Connection,
  ConnectorAdapter,
  ConnectorContext,
  SyncResult,
} from '@manaclaude/shared';
import { afterSyncFailure, afterSyncSuccess } from '../health';
import { ConnectorRateLimitedError, ConnectorRepairNeededError } from '../errors';

export interface SyncOutcome {
  connection: Connection;
  result: SyncResult | null;
  kind: 'ok' | 'needs_repair' | 'error' | 'skipped';
  error: string | null;
  /** A provider's minimum delay must survive into the persistent retry scheduler. */
  retryAfterSeconds?: number | null;
}

/**
 * Run one adapter against one connection and return the updated Connection.
 * Never throws: an expired login becomes status needs_repair, anything else
 * becomes status error with a short message. A connection already marked
 * needs_repair is skipped (no point calling a provider with a dead token)
 * unless `force` is set, which the repair flow uses for its first sync.
 */
export async function runConnectionSync(
  adapter: ConnectorAdapter,
  ctx: ConnectorContext,
  connection: Connection,
  opts: { force?: boolean } = {},
): Promise<SyncOutcome> {
  const now = ctx.now().toISOString();
  if (connection.status === 'needs_repair' && !opts.force) {
    return { connection, result: null, kind: 'skipped', error: connection.lastError };
  }
  try {
    const result = await adapter.sync(ctx, connection);
    return {
      connection: afterSyncSuccess(connection, now, result.nextCursor),
      result,
      kind: 'ok',
      error: null,
    };
  } catch (error) {
    const updated = afterSyncFailure(connection, error, now);
    return {
      connection: updated,
      result: null,
      kind: error instanceof ConnectorRepairNeededError ? 'needs_repair' : 'error',
      error: updated.lastError,
      ...(error instanceof ConnectorRateLimitedError
        ? { retryAfterSeconds: error.retryAfterSeconds }
        : {}),
    };
  }
}
