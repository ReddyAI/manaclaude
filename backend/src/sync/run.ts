import { ConnectorRepairNeededError, type ConnectorContext, type FetchLike } from '@manaclaude/shared';
import { getAdapter } from '@manaclaude/connectors';
import type { Env } from '../env';
import { selectOne } from '../db/table';
import { connectionsTable } from '../db/tables';
import { badRequest, notFound } from '../util/errors';
import { applySyncResult, markConnectionError, type SyncSummary } from './apply';

/**
 * Secrets for one connector: Worker secrets named <CONNECTOR_ID>_<NAME>
 * (TELLER_APP_ID, SOPHTRON_ACCESS_KEY, ...), passed to the adapter as
 * { APP_ID, ACCESS_KEY }. Session D documents each adapter's names.
 */
export function connectorSecrets(env: Env, connectorId: string): Record<string, string> {
  const prefix = `${connectorId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_`;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env as unknown as Record<string, unknown>)) {
    if (key.startsWith(prefix) && typeof value === 'string') out[key.slice(prefix.length)] = value;
  }
  return out;
}

export async function runConnectionSync(env: Env, connectionId: string, doFetch: typeof fetch = fetch): Promise<SyncSummary> {
  const connection = await selectOne(env.DB, connectionsTable, 'id = ?', [connectionId]);
  if (!connection) throw notFound('Connection not found.');
  const adapter = getAdapter(connection.connectorId);
  if (!adapter) throw badRequest(`No adapter for ${connection.connectorId} yet.`, 'no_adapter');
  const ctx: ConnectorContext = {
    secrets: connectorSecrets(env, connection.connectorId),
    fetch: doFetch as unknown as FetchLike,
    now: () => new Date(),
  };
  try {
    const result = await adapter.sync(ctx, connection);
    return await applySyncResult(env.DB, connection, result);
  } catch (e) {
    if (e instanceof ConnectorRepairNeededError) {
      await markConnectionError(env.DB, connection, 'needs_repair', e.message);
      throw badRequest('This connection needs to be repaired in the app.', 'needs_repair');
    }
    await markConnectionError(env.DB, connection, 'error', e instanceof Error ? e.message : 'Sync failed.');
    throw e;
  }
}
