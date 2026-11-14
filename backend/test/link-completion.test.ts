import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection, SophtronLinkStatus } from '@manaclaude/shared';
import type { Env } from '../src/env';
import { createSession } from '../src/link/sessions';
import { insertStatement, selectAll, selectOne } from '../src/db/table';
import { connectionsTable } from '../src/db/tables';
import { meterDb } from '../src/db/meter';
import { loadCredentials, saveCredentials } from '../src/sync/credentials';
import { db, freshDb, testEnv } from './helpers';
import { client } from './worker';

// Invented records only. Every provider request must pass through this fake.
const NOW = new Date('2026-11-14T12:00:00.000Z');
const env: Env = {
  ...testEnv,
  CREDENTIALS_SECRET: 'invented-link-completion-key',
  SOPHTRON_USER_ID: 'invented-user',
  SOPHTRON_ACCESS_KEY: btoa('invented-sophtron-key'),
  SNAPTRADE_CLIENT_ID: 'invented-client',
  SNAPTRADE_CONSUMER_KEY: 'invented-consumer-key',
};
const snapCredentials = {
  SNAPTRADE_USER_ID: 'invented-owner',
  SNAPTRADE_USER_SECRET: 'invented-user-secret',
  SNAPTRADE_AUTHORIZATION_ID: 'invented-authorization',
};
const snapEnabled = { id: snapCredentials.SNAPTRADE_AUTHORIZATION_ID, disabled: false };

beforeEach(freshDb);

function api(reply: () => Promise<Response> | Response, e = env, clock = () => NOW) {
  const fetch = vi.fn(async () => reply());
  return { ...client({ fetch, now: clock }, e), fetch };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function connection(connectorId: string) {
  const c: Connection = {
    id: `conn_${connectorId}`,
    connectorId,
    institutionName: 'Invented institution',
    status: 'needs_repair',
    lastError: 'Login expired',
    syncCursor: 'saved-cursor',
    lastSyncAt: '2026-11-01T12:00:00.000Z',
    lastSuccessfulSyncAt: '2026-10-31T12:00:00.000Z',
    accountIds: ['acc_invented'],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
  await insertStatement(db, connectionsTable, c).run();
  return c;
}

async function sophtron(repair: 'refresh' | 'login' | false = false) {
  const c = repair ? await connection('sophtron') : null;
  if (c)
    await saveCredentials(env, c.id, {
      SOPHTRON_USER_INSTITUTION_ID: 'old-invented-login',
      keep: 'invented-value',
    });
  return createSession(env, {
    connectorId: 'sophtron',
    connectionId: c?.id,
    institutionName: 'Invented Bank',
    minutes: 30,
    now: NOW,
    secret: {
      jobId: 'invented-job',
      ...(repair === 'refresh' ? {} : { userInstitutionId: 'invented-login' }),
    },
  });
}

const poll = (id: string) => `/v1/link/sophtron/${id}`;
const row = (id: string) => db.prepare('SELECT * FROM link_sessions WHERE id = ?').bind(id).first();
const conns = () => selectAll(db, connectionsTable);
const slots = () =>
  db
    .prepare("SELECT used FROM connector_slots WHERE connector_id = 'sophtron'")
    .first<number>('used');

/** Deliberately interrupt the atomic final write, or lose its successful response. */
function interrupted(id: string, phase: 'before' | 'after') {
  let fired = false;
  return new Proxy(db, {
    get(target, key) {
      if (key === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          const status = await target
            .prepare('SELECT status FROM link_sessions WHERE id = ?')
            .bind(id)
            .first('status');
          const interrupt = !fired && status === 'finalizing';
          if (interrupt) {
            fired = true;
            if (phase === 'before') throw new Error('Invented interrupted finalization');
          }
          const result = await target.batch(statements);
          if (interrupt) throw new Error('Invented lost commit response');
          return result;
        };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('Sophtron durable completion', () => {
  it('keeps a transient provider failure retryable on the same sign-in', async () => {
    const s = await sophtron();
    const failing = api(() => new Response('{}', { status: 401 }));
    expect((await failing.api('GET', poll(s.id))).status).toBe(502);
    expect(await row(s.id)).toMatchObject({ status: 'pending', lease_token: null });
    expect(await conns()).toEqual([]);
    const retry = api(() => Response.json({ SuccessFlag: true }));
    expect((await retry.api('GET', poll(s.id))).body).toMatchObject({
      status: 'done',
      connectionIds: [`conn_${s.id.slice(5)}`],
    });
  });
  it.each([false, 'refresh', 'login'] as const)(
    'replays %s completion without calling the provider or overwriting later sync state',
    async (repair) => {
      const s = await sophtron(repair);
      const meter = meterDb(db);
      const a = api(() => Response.json({ SuccessFlag: true }), { ...env, DB: meter.db });
      const done = await a.api<SophtronLinkStatus>('GET', poll(s.id));
      expect(done.status).toBe(200);
      expect(done.body).toEqual({
        linkId: s.id,
        status: 'done',
        connectionIds: [repair ? 'conn_sophtron' : `conn_${s.id.slice(5)}`],
        repaired: !!repair,
      });
      expect(meter.used()).toBeLessThan(35);
      const id = done.body.connectionIds![0]!;
      expect(await loadCredentials(env, id)).toEqual(
        repair === 'refresh'
          ? { SOPHTRON_USER_INSTITUTION_ID: 'old-invented-login', keep: 'invented-value' }
          : {
              SOPHTRON_USER_INSTITUTION_ID: 'invented-login',
              ...(repair ? { keep: 'invented-value' } : {}),
            },
      );
      expect(await loadCredentials(env, s.id)).toEqual({});
      expect(await slots()).toBe(repair ? null : 1);
      await db
        .prepare(
          "UPDATE connections SET status = 'healthy', last_error = 'later state' WHERE id = ?",
        )
        .bind(id)
        .run();
      const restarted = api(() => {
        throw new Error('No provider request on replay');
      });
      expect((await restarted.api('GET', poll(s.id))).body).toEqual(done.body);
      expect(restarted.fetch).not.toHaveBeenCalled();
      expect(await conns()).toHaveLength(1);
      expect(await selectOne(db, connectionsTable, 'id = ?', [id])).toMatchObject({
        status: 'healthy',
        lastError: 'later state',
        ...(repair ? { syncCursor: 'saved-cursor', accountIds: ['acc_invented'] } : {}),
      });
    },
  );

  it('serializes overlapping polls and replays after the first success answer is lost', async () => {
    const s = await sophtron();
    const entered = deferred<void>();
    const release = deferred<Response>();
    const a = api(() => {
      entered.resolve();
      return release.promise;
    });
    const first = a.api('GET', poll(s.id));
    await entered.promise;
    const overlaps = await Promise.all(Array.from({ length: 5 }, () => a.api('GET', poll(s.id))));
    expect(
      overlaps.every(
        (r) => r.status === 200 && (r.body as SophtronLinkStatus).status === 'pending',
      ),
    ).toBe(true);
    expect(a.fetch).toHaveBeenCalledTimes(1);
    release.resolve(Response.json({ SuccessFlag: true }));
    const lost = await first;
    expect(lost.status).toBe(200);
    expect((await a.api('GET', poll(s.id))).body).toEqual(lost.body);
    expect(await conns()).toHaveLength(1);
    expect(await slots()).toBe(1);
  });

  it.each(['before', 'after'] as const)(
    'recovers interruption %s final commit without another provider request',
    async (phase) => {
      const s = await sophtron();
      const a = api(() => Response.json({ SuccessFlag: true }), {
        ...env,
        DB: interrupted(s.id, phase),
      });
      expect((await a.api('GET', poll(s.id))).status).toBe(500);
      expect(await row(s.id)).toMatchObject({ status: phase === 'before' ? 'finalizing' : 'done' });
      expect(await conns()).toHaveLength(phase === 'before' ? 0 : 1);
      const b = api(() => {
        throw new Error('Provider success is already persisted');
      });
      expect((await b.api('GET', poll(s.id))).body).toMatchObject({
        status: 'done',
        repaired: false,
        connectionIds: [`conn_${s.id.slice(5)}`],
      });
      expect(b.fetch).not.toHaveBeenCalled();
      expect(await conns()).toHaveLength(1);
      expect(await slots()).toBe(1);
    },
  );

  it.each([false, 'login'] as const)(
    'rolls back credentials, connection, slot and result on an in-batch failure (%s)',
    async (repair) => {
      const s = await sophtron(repair);
      const before = await conns();
      const oldCreds = repair ? await loadCredentials(env, 'conn_sophtron') : {};
      await db
        .prepare(
          "CREATE TRIGGER fail_link_done BEFORE UPDATE OF status ON link_sessions WHEN NEW.status = 'done' BEGIN SELECT RAISE(ABORT, 'invented interruption'); END",
        )
        .run();
      try {
        expect(
          (await api(() => Response.json({ SuccessFlag: true })).api('GET', poll(s.id))).status,
        ).toBe(500);
      } finally {
        await db.prepare('DROP TRIGGER fail_link_done').run();
      }
      expect(await conns()).toEqual(before);
      expect(
        await loadCredentials(env, repair ? 'conn_sophtron' : `conn_${s.id.slice(5)}`),
      ).toEqual(oldCreds);
      expect(await slots()).toBeNull();
      expect(await row(s.id)).toMatchObject({ status: 'finalizing', completion_json: null });
      expect(await loadCredentials(env, s.id)).toHaveProperty('jobId');
      const b = api(() => {
        throw new Error('Must resume finalization');
      });
      expect((await b.api('GET', poll(s.id))).status).toBe(200);
      expect(await conns()).toHaveLength(1);
    },
  );

  it.each([
    { SuccessFlag: false, LastStatus: 'Failed' },
    { SuccessFlag: true },
    { SecurityQuestion: '["Invented question?"]' },
  ])('fences a late provider reply %j after lease takeover', async (oldReply) => {
    const s = await sophtron();
    let now = NOW;
    const entered = deferred<void>();
    const release = deferred<Response>();
    const old = api(
      () => {
        entered.resolve();
        return release.promise;
      },
      env,
      () => now,
    );
    const first = old.api('GET', poll(s.id));
    await entered.promise;
    now = new Date(NOW.getTime() + 120_001);
    const replacement = api(
      () => Response.json({ SuccessFlag: true }),
      env,
      () => now,
    );
    const done = await replacement.api('GET', poll(s.id));
    release.resolve(Response.json(oldReply));
    expect((await first).body).toEqual(done.body);
    expect(await slots()).toBe(1);
    expect(await conns()).toHaveLength(1);
    expect(await row(s.id)).toMatchObject({ status: 'done', lease_token: null });
  });

  it('reclaims a crashed finalizer only after its lease expires', async () => {
    const s = await sophtron();
    await db
      .prepare(
        "UPDATE link_sessions SET status = 'finalizing', lease_token = 'abandoned', lease_expires_at = ? WHERE id = ?",
      )
      .bind(new Date(NOW.getTime() + 120_000).toISOString(), s.id)
      .run();
    let now = NOW;
    const a = api(
      () => {
        throw new Error('No provider calls');
      },
      env,
      () => now,
    );
    expect((await a.api('GET', poll(s.id))).body).toEqual({ linkId: s.id, status: 'pending' });
    now = new Date(NOW.getTime() + 120_000);
    expect((await a.api('GET', poll(s.id))).body).toMatchObject({
      status: 'done',
      connectionIds: [`conn_${s.id.slice(5)}`],
    });
    expect(a.fetch).not.toHaveBeenCalled();
  });

  it('expires attempts and results; a provider reply arriving after expiry writes nothing', async () => {
    const s = await sophtron();
    let now = NOW;
    const a = api(
      () => {
        now = new Date(NOW.getTime() + 30 * 60_000 + 1);
        return Response.json({ SuccessFlag: true });
      },
      env,
      () => now,
    );
    expect((await a.api('GET', poll(s.id))).status).toBe(404);
    expect(await conns()).toEqual([]);
    const s2 = await sophtron();
    const b = api(() => Response.json({ SuccessFlag: true }));
    expect((await b.api('GET', poll(s2.id))).status).toBe(200);
    expect((await a.api('GET', poll(s2.id))).status).toBe(404);
  });

  it('never reports a legacy done row as success without IDs or guesses a duplicate connection', async () => {
    const s = await sophtron();
    await db.prepare("UPDATE link_sessions SET status = 'done' WHERE id = ?").bind(s.id).run();
    const a = api(() => {
      throw new Error('No provider calls');
    });
    expect((await a.api('GET', poll(s.id))).body).toMatchObject({
      error: 'link_result_unavailable',
    });
    expect(await conns()).toEqual([]);
  });
});

async function snaptrade() {
  const c = await connection('snaptrade');
  await saveCredentials(env, c.id, snapCredentials);
  const s = await createSession(env, {
    connectorId: 'snaptrade',
    connectionId: c.id,
    secret: snapCredentials,
    minutes: 30,
    now: NOW,
  });
  return { c, s, path: `/v1/link/snaptrade/${s.id}/complete` };
}

describe('SnapTrade exact saved authorization repair', () => {
  it('does not treat a returned browser session as proof of an enabled authorization', async () => {
    const { c, s, path } = await snaptrade();
    await db.prepare("UPDATE link_sessions SET status = 'returned' WHERE id = ?").bind(s.id).run();
    expect(
      (await api(() => Response.json([{ ...snapEnabled, disabled: true }])).api('POST', path)).body,
    ).toMatchObject({ error: 'repair_not_finished' });
    expect(await conns()).toEqual([c]);
    expect(await row(s.id)).toMatchObject({ status: 'returned' });
  });

  it('overlapping successful completions cannot clear a later repair error twice', async () => {
    const { c, path } = await snaptrade();
    const entered = deferred<void>();
    const release = deferred<Response>();
    const slow = api(() => {
      entered.resolve();
      return release.promise;
    });
    const first = slow.api('POST', path);
    await entered.promise;
    expect((await api(() => Response.json([snapEnabled])).api('POST', path)).status).toBe(200);
    await db
      .prepare(
        "UPDATE connections SET status = 'needs_repair', last_error = 'New failure' WHERE id = ?",
      )
      .bind(c.id)
      .run();
    release.resolve(Response.json([snapEnabled]));
    expect((await first).body).toMatchObject({ error: 'connection_changed' });
    expect(await selectOne(db, connectionsTable, 'id = ?', [c.id])).toMatchObject({
      status: 'needs_repair',
      lastError: 'New failure',
    });
  });
  it.each(
    [
      [],
      [snapEnabled, { id: 'other', disabled: false }].slice(1),
      [{ ...snapEnabled, disabled: true }],
      [{ id: snapEnabled.id }],
      [{ ...snapEnabled, disabled: null }],
      [{ ...snapEnabled, disabled: 'false' }],
      [snapEnabled, { ...snapEnabled, disabled: true }],
    ].map((auths) => ({ auths })),
  )('refuses an absent, unconfirmed or ambiguous authorization: %j', async ({ auths }) => {
    const { c, s, path } = await snaptrade();
    const a = api(() => Response.json(auths));
    const r = await a.api('POST', path);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({
      error: 'repair_not_finished',
      message: expect.stringMatching(/still needs repair/),
    });
    expect(await conns()).toEqual([c]);
    expect(await loadCredentials(env, c.id)).toEqual(snapCredentials);
    expect(await row(s.id)).toMatchObject({ status: 'pending' });
    expect((await db.prepare('SELECT * FROM connector_slots').all()).results).toEqual([]);
  });

  it.each([401, 500, 'malformed'] as const)(
    'preserves repair state after an unsuccessful provider response %s',
    async (response) => {
      const { c, path } = await snaptrade();
      const a = api(() =>
        response === 'malformed'
          ? Response.json({ error: 'invented-failure' })
          : new Response('{}', { status: response }),
      );
      const r = await a.api('POST', path);
      expect(r.status).toBe(502);
      expect(r.body).toMatchObject({ error: 'provider_error' });
      expect(await conns()).toEqual([c]);
    },
  );

  it('allows a retry only once the saved authorization is explicitly enabled, using its saved user', async () => {
    const { c, s, path } = await snaptrade();
    let enabled = false;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/api/v1/authorizations');
      expect(url.searchParams.get('userId')).toBe(snapCredentials.SNAPTRADE_USER_ID);
      return Response.json([{ ...snapEnabled, disabled: !enabled }]);
    });
    const a = client({ fetch, now: () => NOW }, env);
    expect((await a.api('POST', path)).status).toBe(409);
    enabled = true;
    expect((await a.api('POST', path)).body).toEqual({ connectionIds: [c.id], repaired: true });
    expect(await conns()).toEqual([{ ...c, status: 'syncing', lastError: null }]);
    expect(await row(s.id)).toMatchObject({ status: 'done' });
    expect(await loadCredentials(env, s.id)).toEqual({});
    expect((await a.api('POST', path)).status).toBe(404);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not accept a different saved authorization after the portal was opened', async () => {
    const { c, path } = await snaptrade();
    await saveCredentials(env, c.id, { SNAPTRADE_AUTHORIZATION_ID: 'replacement-authorization' });
    const a = api(() => Response.json([{ id: 'replacement-authorization', disabled: false }]));
    expect((await a.api('POST', path)).body).toMatchObject({ error: 'connection_changed' });
    expect(a.fetch).not.toHaveBeenCalled();
    expect(await conns()).toEqual([c]);
  });

  it('fences a saved-credential change while authorization verification is in flight', async () => {
    const { c, path } = await snaptrade();
    const a = api(async () => {
      await saveCredentials(env, c.id, { SNAPTRADE_AUTHORIZATION_ID: 'replacement-authorization' });
      return Response.json([snapEnabled]);
    });
    expect((await a.api('POST', path)).body).toMatchObject({ error: 'connection_changed' });
    expect(await conns()).toEqual([c]);
  });

  it('requires the saved authorization and rolls back repair if session completion fails', async () => {
    const { c, path } = await snaptrade();
    await db
      .prepare(
        "CREATE TRIGGER fail_snap_done BEFORE UPDATE OF status ON link_sessions WHEN NEW.status = 'done' BEGIN SELECT RAISE(ABORT, 'invented interruption'); END",
      )
      .run();
    try {
      expect((await api(() => Response.json([snapEnabled])).api('POST', path)).status).toBe(500);
    } finally {
      await db.prepare('DROP TRIGGER fail_snap_done').run();
    }
    expect(await conns()).toEqual([c]);
    await saveCredentials(env, c.id, {}, { replace: true });
    const a = api(() => {
      throw new Error('No provider calls without saved identity');
    });
    expect((await a.api('POST', path)).body).toMatchObject({ error: 'repair_not_finished' });
    expect(
      (await a.api('POST', '/v1/link/snaptrade/start', { connectionId: c.id })).body,
    ).toMatchObject({ error: 'repair_not_finished' });
    expect(a.fetch).not.toHaveBeenCalled();
    expect(await conns()).toEqual([c]);
  });
});
