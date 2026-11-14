import { getSophtronJob } from '@manaclaude/connectors';
import type { Connection, ConnectorContext, SophtronLinkStatus } from '@manaclaude/shared';
import type { Env } from '../env';
import { insertStatement } from '../db/table';
import { connectionsTable } from '../db/tables';
import { prepareCredentials } from '../sync/credentials';
import { conflict, notFound } from '../util/errors';
import { newId, nowIso } from '../util/ids';
import { loadConnectionFor } from './service';
import { getSession, sessionSecret, type LinkSession } from './sessions';
import { credentialStateSql, LinkWriteChanged, writeLink } from './writes';

const LEASE_MS = 120_000;

function terminal(session: LinkSession): SophtronLinkStatus | null {
  if (session.status === 'done') {
    if (!session.completion) {
      // Old Workers did not record which new connection they created. Never guess
      // or repeat that write: it might already have succeeded before interruption.
      throw conflict(
        'This older sign-in has no saved result. Reload Accounts to check it before starting again.',
        'link_result_unavailable',
      );
    }
    return { linkId: session.id, status: 'done', ...session.completion };
  }
  if (session.status === 'failed') {
    return { linkId: session.id, status: 'failed', message: 'This attempt ended. Start again.' };
  }
  return null;
}

async function current(env: Env, id: string, now: Date): Promise<SophtronLinkStatus> {
  const session = await getSession(env, id, 'sophtron', now);
  if (!session) throw notFound('This sign-in has expired. Start again.');
  return terminal(session) ?? { linkId: id, status: 'pending' };
}

/** Persist success before finalizing; commit the result and all effects together. */
export async function sophtronStatus(
  env: Env,
  session: LinkSession,
  ctx: ConnectorContext,
  now: () => Date,
): Promise<SophtronLinkStatus> {
  const done = terminal(session);
  if (done) return done;
  const token = newId('poll');
  const at = now();
  const claimed = await env.DB.prepare(
    `UPDATE link_sessions SET lease_token = ?, lease_expires_at = ?
    WHERE id = ? AND status IN ('pending', 'finalizing') AND expires_at >= ?
      AND (lease_token IS NULL OR lease_expires_at <= ?)
    RETURNING status`,
  )
    .bind(token, nowIso(new Date(at.getTime() + LEASE_MS)), session.id, nowIso(at), nowIso(at))
    .first<{ status: LinkSession['status'] }>();
  if (!claimed) return current(env, session.id, now());

  const guard = () => ({
    sql: `EXISTS (SELECT 1 FROM link_sessions WHERE id = ? AND lease_token = ?
      AND lease_expires_at > ? AND expires_at >= ? AND status IN ('pending', 'finalizing'))`,
    params: [session.id, token, nowIso(now()), nowIso(now())],
  });
  try {
    const secret = await sessionSecret(env, session.id);
    if (claimed.status !== 'finalizing') {
      if (!secret.jobId)
        throw conflict('This sign-in has no saved job. Start again.', 'link_result_unavailable');
      const job = await getSophtronJob(ctx, secret.jobId);
      if (job.state === 'pending' || job.state === 'mfa') {
        // A delayed owner must not report an obsolete challenge after takeover.
        await writeLink(env.DB, [guard()], []);
        return job.state === 'pending'
          ? { linkId: session.id, status: 'pending' }
          : { linkId: session.id, status: 'mfa', challenge: job.challenge };
      }
      if (job.state === 'failed') {
        await writeLink(
          env.DB,
          [guard()],
          [
            env.DB.prepare(
              "UPDATE link_sessions SET status = 'failed', updated_at = ? WHERE id = ?",
            ).bind(nowIso(now()), session.id),
            env.DB.prepare('DELETE FROM connection_credentials WHERE connection_id = ?').bind(
              session.id,
            ),
          ],
        );
        return { linkId: session.id, status: 'failed', message: job.reason };
      }
      await writeLink(
        env.DB,
        [guard()],
        [
          env.DB.prepare(
            "UPDATE link_sessions SET status = 'finalizing', updated_at = ? WHERE id = ?",
          ).bind(nowIso(now()), session.id),
        ],
      );
    }

    const connectionId = session.connectionId ?? `conn_${session.id.slice(5)}`;
    const result = { connectionIds: [connectionId], repaired: session.connectionId !== null };
    const checks = [];
    const effects: D1PreparedStatement[] = [];
    const timestamp = nowIso(now());
    if (session.connectionId) {
      await loadConnectionFor(env.DB, connectionId, 'sophtron');
      checks.push({
        sql: "EXISTS (SELECT 1 FROM connections WHERE id = ? AND connector_id = 'sophtron')",
        params: [connectionId],
      });
      effects.push(
        env.DB.prepare(
          "UPDATE connections SET status = 'syncing', last_error = NULL, updated_at = ? WHERE id = ?",
        ).bind(timestamp, connectionId),
      );
    } else {
      if (!secret.userInstitutionId)
        throw conflict('This sign-in has no saved login. Start again.', 'link_result_unavailable');
      const connection: Connection = {
        id: connectionId,
        connectorId: 'sophtron',
        institutionName: (session.institutionName ?? 'Bank').slice(0, 120),
        status: 'syncing',
        lastSyncAt: null,
        lastSuccessfulSyncAt: null,
        lastError: null,
        syncCursor: null,
        accountIds: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      effects.push(insertStatement(env.DB, connectionsTable, connection));
      effects.push(
        env.DB.prepare(
          "INSERT INTO connector_slots (connector_id, used) VALUES ('sophtron', 1) ON CONFLICT (connector_id) DO UPDATE SET used = used + 1",
        ),
      );
    }
    if (secret.userInstitutionId) {
      const state = await env.DB.prepare(credentialStateSql)
        .bind(connectionId)
        .first<string>('state');
      effects.push(
        await prepareCredentials(env, connectionId, {
          SOPHTRON_USER_INSTITUTION_ID: secret.userInstitutionId,
        }),
      );
      checks.push({ sql: `(${credentialStateSql}) IS ?`, params: [connectionId, state] });
    }
    effects.push(
      env.DB.prepare(
        "UPDATE link_sessions SET status = 'done', completion_json = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?",
      ).bind(JSON.stringify(result), timestamp, session.id),
      env.DB.prepare('DELETE FROM connection_credentials WHERE connection_id = ?').bind(session.id),
    );
    await writeLink(env.DB, [guard(), ...checks], effects);
    return { linkId: session.id, status: 'done', ...result };
  } catch (error) {
    if (error instanceof LinkWriteChanged) return await current(env, session.id, now());
    throw error;
  } finally {
    // Abrupt termination leaves an expiring lease; never release another owner's.
    await env.DB.prepare(
      'UPDATE link_sessions SET lease_token = NULL, lease_expires_at = NULL WHERE id = ? AND lease_token = ?',
    )
      .bind(session.id, token)
      .run();
  }
}
