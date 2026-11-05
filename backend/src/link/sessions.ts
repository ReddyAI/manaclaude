import type { Env } from '../env';
import {
  deleteCredentials,
  loadCredentials,
  saveCredentials,
  type Credentials,
} from '../sync/credentials';
import { newId, nowIso } from '../util/ids';

/**
 * A link attempt in progress. The row says which connector, which connection
 * it repairs, where the browser returns to and when it expires. Anything
 * provider-side (a Sophtron job id and login id) is stored encrypted under
 * "link_<id>" in connection_credentials and deleted when the attempt ends.
 */
export interface LinkSession {
  id: string;
  connectorId: string;
  connectionId: string | null;
  status: 'pending' | 'returned' | 'done' | 'failed';
  institutionName: string | null;
  returnUrl: string | null;
  expiresAt: string;
}

interface Row {
  id: string;
  connector_id: string;
  connection_id: string | null;
  status: LinkSession['status'];
  institution_name: string | null;
  return_url: string | null;
  expires_at: string;
}

const fromRow = (r: Row): LinkSession => ({
  id: r.id,
  connectorId: r.connector_id,
  connectionId: r.connection_id,
  status: r.status,
  institutionName: r.institution_name,
  returnUrl: r.return_url,
  expiresAt: r.expires_at,
});

export async function createSession(
  env: Env,
  input: {
    connectorId: string;
    connectionId?: string | null;
    institutionName?: string | null;
    returnUrl?: string | null;
    minutes: number;
    secret?: Credentials;
    now?: Date;
  },
): Promise<LinkSession> {
  const now = input.now ?? new Date();
  const session: LinkSession = {
    id: newId('link'),
    connectorId: input.connectorId,
    connectionId: input.connectionId ?? null,
    status: 'pending',
    institutionName: input.institutionName ?? null,
    returnUrl: input.returnUrl ?? null,
    expiresAt: new Date(now.getTime() + input.minutes * 60_000).toISOString(),
  };
  if (input.secret) await saveCredentials(env, session.id, input.secret, { replace: true });
  // Old attempts are cleared on the way, so the table never grows.
  await env.DB.batch([
    env.DB.prepare(
      'DELETE FROM connection_credentials WHERE connection_id IN (SELECT id FROM link_sessions WHERE expires_at < ?)',
    ).bind(nowIso(now)),
    env.DB.prepare('DELETE FROM link_sessions WHERE expires_at < ?').bind(nowIso(now)),
    env.DB.prepare(
      'INSERT INTO link_sessions (id, connector_id, connection_id, status, institution_name, return_url, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      session.id,
      session.connectorId,
      session.connectionId,
      session.status,
      session.institutionName,
      session.returnUrl,
      session.expiresAt,
      nowIso(now),
      nowIso(now),
    ),
  ]);
  return session;
}

/** The session if it exists, belongs to this connector and has not expired. */
export async function getSession(
  env: Env,
  id: string,
  connectorId: string,
  now = new Date(),
): Promise<LinkSession | null> {
  if (!/^link_[a-f0-9]{32}$/.test(id)) return null;
  const row = await env.DB.prepare('SELECT * FROM link_sessions WHERE id = ?')
    .bind(id)
    .first<Row>();
  if (!row || row.connector_id !== connectorId || row.expires_at < nowIso(now)) return null;
  return fromRow(row);
}

export function sessionSecret(env: Env, id: string): Promise<Credentials> {
  return loadCredentials(env, id);
}

/**
 * Moves a session from one status to another, only if it is still in `from`.
 * Returns false when another request got there first, which makes a callback
 * single-use.
 */
export async function moveSession(
  env: Env,
  id: string,
  from: LinkSession['status'][],
  to: LinkSession['status'],
  now = new Date(),
): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE link_sessions SET status = ?, updated_at = ? WHERE id = ? AND status IN (${from.map(() => '?').join(',')})`,
  )
    .bind(to, nowIso(now), id, ...from)
    .run();
  return (res.meta.changes ?? 0) === 1;
}

export async function endSession(
  env: Env,
  id: string,
  status: 'done' | 'failed',
  now = new Date(),
): Promise<void> {
  await env.DB.prepare('UPDATE link_sessions SET status = ?, updated_at = ? WHERE id = ?')
    .bind(status, nowIso(now), id)
    .run();
  await deleteCredentials(env, id);
}
