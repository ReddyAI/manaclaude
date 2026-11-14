import { listSnaptradeAuthorizations } from '@manaclaude/connectors';
import type { ConnectorContext, LinkDoneResponse } from '@manaclaude/shared';
import type { Env } from '../env';
import { loadCredentials, type Credentials } from '../sync/credentials';
import { conflict } from '../util/errors';
import { nowIso } from '../util/ids';
import { loadConnectionFor } from './service';
import { sessionSecret, type LinkSession } from './sessions';
import { credentialStateSql, LinkWriteChanged, writeLink } from './writes';

const unfinished = () =>
  conflict(
    'SnapTrade has not confirmed that this saved brokerage login is enabled. This connection still needs repair. Finish reconnecting it in SnapTrade, then try Done again.',
    'repair_not_finished',
  );

export async function snaptradeRepairCredentials(
  env: Env,
  connectionId: string,
): Promise<Credentials> {
  const creds = await loadCredentials(env, connectionId);
  if (
    !creds.SNAPTRADE_AUTHORIZATION_ID ||
    !creds.SNAPTRADE_USER_ID ||
    !creds.SNAPTRADE_USER_SECRET
  ) {
    throw unfinished();
  }
  return creds;
}

export async function completeSnaptradeRepair(
  env: Env,
  session: LinkSession,
  ctx: ConnectorContext,
  now: () => Date,
): Promise<LinkDoneResponse> {
  const connectionId = session.connectionId!;
  await loadConnectionFor(env.DB, connectionId, 'snaptrade');
  const state = await env.DB.prepare(credentialStateSql).bind(connectionId).first<string>('state');
  const creds = await snaptradeRepairCredentials(env, connectionId);
  const original = await sessionSecret(env, session.id);
  // Pre-migration sessions have no snapshot. They still verify the exact current
  // saved authorization; new sessions also bind completion to the portal's login.
  if (
    Object.keys(original).length &&
    ['SNAPTRADE_AUTHORIZATION_ID', 'SNAPTRADE_USER_ID', 'SNAPTRADE_USER_SECRET'].some(
      (key) => original[key] !== creds[key],
    )
  ) {
    throw conflict(
      'This connection changed after the repair started. Start repair again.',
      'connection_changed',
    );
  }
  const auths = await listSnaptradeAuthorizations(ctx, {
    userId: creds.SNAPTRADE_USER_ID!,
    userSecret: creds.SNAPTRADE_USER_SECRET!,
  });
  const matching = auths.filter((a) => a.id === creds.SNAPTRADE_AUTHORIZATION_ID);
  if (matching.length !== 1 || matching[0]!.disabled) throw unfinished();
  const timestamp = nowIso(now());
  try {
    await writeLink(
      env.DB,
      [
        {
          sql: `EXISTS (SELECT 1 FROM link_sessions WHERE id = ? AND status IN ('pending', 'returned') AND expires_at >= ?)`,
          params: [session.id, timestamp],
        },
        {
          sql: `EXISTS (SELECT 1 FROM connections WHERE id = ? AND connector_id = 'snaptrade') AND (${credentialStateSql}) IS ?`,
          params: [connectionId, connectionId, state],
        },
      ],
      [
        env.DB.prepare(
          "UPDATE connections SET status = 'syncing', last_error = NULL, updated_at = ? WHERE id = ?",
        ).bind(timestamp, connectionId),
        env.DB.prepare(
          "UPDATE link_sessions SET status = 'done', updated_at = ? WHERE id = ?",
        ).bind(timestamp, session.id),
        env.DB.prepare('DELETE FROM connection_credentials WHERE connection_id = ?').bind(
          session.id,
        ),
      ],
    );
  } catch (error) {
    if (error instanceof LinkWriteChanged)
      throw conflict(
        'The connection or repair attempt changed. Reload Accounts before trying again.',
        'connection_changed',
      );
    throw error;
  }
  return { connectionIds: [connectionId], repaired: true };
}
