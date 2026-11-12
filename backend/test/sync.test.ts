import { beforeEach, describe, expect, it } from 'vitest';
import type { Connection } from '@manaclaude/shared';
import { ConnectorConfigError } from '@manaclaude/connectors';
import sfAccounts from '../../connectors/fixtures/simplefin/accounts.json';
import qtToken from '../../connectors/fixtures/questrade/token.json';
import qtAccounts from '../../connectors/fixtures/questrade/accounts.json';
import qtBalancesTfsa from '../../connectors/fixtures/questrade/balances_tfsa.json';
import qtBalancesRrsp from '../../connectors/fixtures/questrade/balances_rrsp.json';
import qtPositionsTfsa from '../../connectors/fixtures/questrade/positions_tfsa.json';
import qtPositionsRrsp from '../../connectors/fixtures/questrade/positions_rrsp.json';
import qtActivitiesTfsa from '../../connectors/fixtures/questrade/activities_tfsa.json';
import qtActivitiesRrsp from '../../connectors/fixtures/questrade/activities_rrsp.json';
import rentcastAvm from '../../connectors/fixtures/rentcast/avm.json';
import { insertStatement, selectAll, selectOne } from '../src/db/table';
import {
  accountsTable,
  activitiesTable,
  connectionsTable,
  holdingsTable,
  taxLotsTable,
  transactionsTable,
} from '../src/db/tables';
import type { Env } from '../src/env';
import { deleteCredentials, loadCredentials, saveCredentials } from '../src/sync/credentials';
import { workerSecretsFor } from '../src/sync/secrets';
import {
  fetchForConnector,
  syncAllConnections,
  syncConnection,
  syncDueConnections,
} from '../src/sync/run';
import { D1_QUERIES_PER_INVOCATION, meterDb } from '../src/db/meter';
import { freshDb, testEnv } from './helpers';

const env: Env = { ...testEnv, CREDENTIALS_SECRET: 'test-credentials-secret-0123456789' };
const db = env.DB;

const NOW = new Date('2026-11-05T12:00:00.000Z');

function connection(id: string, connectorId: string, over: Partial<Connection> = {}): Connection {
  return {
    id,
    connectorId,
    institutionName: 'Demo Bank',
    status: 'healthy',
    lastSyncAt: null,
    lastSuccessfulSyncAt: null,
    lastError: null,
    syncCursor: null,
    accountIds: [],
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  };
}

async function addConnection(c: Connection): Promise<void> {
  await insertStatement(db, connectionsTable, c).run();
}

type Handler = (url: URL, init?: RequestInit) => unknown;

/** A fetch that answers from saved connector fixtures and records every call. */
function fakeFetch(routes: Record<string, Handler | unknown>) {
  const calls: { method: string; url: URL; headers: Record<string, string> }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url, headers: (init?.headers ?? {}) as Record<string, string> });
    const key = `${method} ${url.host}${url.pathname}`;
    if (!(key in routes)) throw new Error(`no route for ${key}`);
    const h = routes[key];
    const body = typeof h === 'function' ? (h as Handler)(url, init) : h;
    const status =
      body && typeof body === 'object' && 'status' in (body as object)
        ? (body as { status: number }).status
        : 200;
    const json =
      body && typeof body === 'object' && 'json' in (body as object)
        ? (body as { json: unknown }).json
        : body;
    return new Response(JSON.stringify(json), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return Object.assign(fn, { calls });
}

const SF_URL = 'https://demouser:demopass@bridge.example.invalid/simplefin';
const sfRoutes = () => ({ 'GET bridge.example.invalid/simplefin/accounts': sfAccounts });

const questradeRoutes = () => ({
  'POST login.questrade.com/oauth2/token': qtToken,
  'GET api01.iq.questrade.com/v1/accounts': qtAccounts,
  'GET api01.iq.questrade.com/v1/accounts/51000001/balances': qtBalancesTfsa,
  'GET api01.iq.questrade.com/v1/accounts/51000002/balances': qtBalancesRrsp,
  'GET api01.iq.questrade.com/v1/accounts/51000001/positions': qtPositionsTfsa,
  'GET api01.iq.questrade.com/v1/accounts/51000002/positions': qtPositionsRrsp,
  'GET api01.iq.questrade.com/v1/accounts/51000001/activities': qtActivitiesTfsa,
  'GET api01.iq.questrade.com/v1/accounts/51000002/activities': qtActivitiesRrsp,
});

beforeEach(freshDb);

describe('encrypted connection credentials', () => {
  it('round-trips values and stores nothing readable', async () => {
    await saveCredentials(env, 'conn_a', { PLAID_ACCESS_TOKEN: 'token_super_secret_value' });
    expect(await loadCredentials(env, 'conn_a')).toEqual({
      PLAID_ACCESS_TOKEN: 'token_super_secret_value',
    });
    const raw = await db
      .prepare('SELECT * FROM connection_credentials WHERE connection_id = ?')
      .bind('conn_a')
      .first<Record<string, string>>();
    expect(JSON.stringify(raw)).not.toContain('token_super_secret_value');
    expect(JSON.stringify(raw)).not.toContain('PLAID_ACCESS_TOKEN');
  });

  it('merges new values into the saved ones, and replace overwrites', async () => {
    await saveCredentials(env, 'conn_a', { A: '1', B: '2' });
    await saveCredentials(env, 'conn_a', { B: '3' });
    expect(await loadCredentials(env, 'conn_a')).toEqual({ A: '1', B: '3' });
    await saveCredentials(env, 'conn_a', { C: '4' }, { replace: true });
    expect(await loadCredentials(env, 'conn_a')).toEqual({ C: '4' });
    await deleteCredentials(env, 'conn_a');
    expect(await loadCredentials(env, 'conn_a')).toEqual({});
  });

  it('uses a fresh IV each time and keeps connections apart', async () => {
    await saveCredentials(env, 'conn_a', { A: '1' });
    await saveCredentials(env, 'conn_b', { A: '1' });
    const rows = await db
      .prepare('SELECT iv, ciphertext FROM connection_credentials')
      .all<{ iv: string; ciphertext: string }>();
    expect(new Set(rows.results.map((r) => r.iv)).size).toBe(2);
    expect(new Set(rows.results.map((r) => r.ciphertext)).size).toBe(2);
  });

  it('refuses to save without CREDENTIALS_SECRET and to read with a different one', async () => {
    await expect(
      saveCredentials({ ...env, CREDENTIALS_SECRET: undefined }, 'conn_a', { A: '1' }),
    ).rejects.toBeInstanceOf(ConnectorConfigError);
    await saveCredentials(env, 'conn_a', { A: '1' });
    await expect(
      loadCredentials({ ...env, CREDENTIALS_SECRET: 'another-secret-entirely' }, 'conn_a'),
    ).rejects.toThrow(/could not be decrypted/);
  });
});

describe('Worker secrets per connector', () => {
  it('gives a connector only its own names, and skips empty ones', () => {
    const e = {
      ...env,
      PLAID_CLIENT_ID: 'cid',
      PLAID_SECRET: 'sec',
      PLAID_ENV: '',
      SOPHTRON_USER_ID: 'u',
      KITE_API_KEY: 'k',
    } as Env;
    expect(workerSecretsFor(e, 'plaid')).toEqual({ PLAID_CLIENT_ID: 'cid', PLAID_SECRET: 'sec' });
    expect(workerSecretsFor(e, 'zerodha_kite')).toEqual({ KITE_API_KEY: 'k' });
    expect(workerSecretsFor(e, 'simplefin')).toEqual({});
  });
});

describe('syncConnection with the connectors package', () => {
  it('syncs SimpleFIN through the planners: accounts, balances, transactions, connection health', async () => {
    await addConnection(connection('conn_sf', 'simplefin'));
    await saveCredentials(env, 'conn_sf', { SIMPLEFIN_ACCESS_URL: SF_URL });
    const fetch = fakeFetch(sfRoutes());
    const report = await syncConnection(env, 'conn_sf', { fetch, now: () => NOW });
    expect(report).toMatchObject({ outcome: 'ok', status: 'healthy', error: null });
    expect(report.summary?.accountsCreated).toBe(3);
    expect(report.summary?.inserted).toBeGreaterThan(0);
    const accounts = await selectAll(db, accountsTable);
    expect(accounts.map((a) => a.connectionId)).toEqual(['conn_sf', 'conn_sf', 'conn_sf']);
    const txns = await selectAll(db, transactionsTable);
    expect(txns).toHaveLength(report.summary?.inserted ?? -1);
    const conn = await selectOne(db, connectionsTable, 'id = ?', ['conn_sf']);
    expect(conn?.status).toBe('healthy');
    expect(conn?.lastSuccessfulSyncAt).toBe(NOW.toISOString());
    expect(conn?.syncCursor).toBeTruthy();
    expect([...(conn?.accountIds ?? [])].sort()).toEqual(accounts.map((a) => a.id).sort());
    const snapshots = await db.prepare('SELECT COUNT(*) AS n FROM balance_snapshots').first<{
      n: number;
    }>();
    expect(snapshots?.n).toBe(3);
    // The saved access URL's user and password reached SimpleFIN as Basic auth, not in the URL.
    const auth = fetch.calls[0]?.headers.Authorization ?? '';
    expect(atob(auth.replace('Basic ', ''))).toBe('demouser:demopass');
    expect(fetch.calls[0]?.url.username).toBe('');
  });

  it('a repeat sync adds nothing and keeps one row per provider id', async () => {
    await addConnection(connection('conn_sf', 'simplefin'));
    await saveCredentials(env, 'conn_sf', { SIMPLEFIN_ACCESS_URL: SF_URL });
    const first = await syncConnection(env, 'conn_sf', {
      fetch: fakeFetch(sfRoutes()),
      now: () => NOW,
    });
    const before = await selectAll(db, transactionsTable);
    const again = await syncConnection(env, 'conn_sf', {
      fetch: fakeFetch(sfRoutes()),
      now: () => NOW,
    });
    expect(again.summary).toMatchObject({ accountsCreated: 0, inserted: 0, removed: 0 });
    expect(await selectAll(db, transactionsTable)).toHaveLength(before.length);
    expect(first.summary?.inserted).toBe(before.length);
  });

  it('uses an injected fetch for every connector', () => {
    const injected = fakeFetch({});
    expect(fetchForConnector(env, 'sophtron', injected)).toBe(injected);
    expect(fetchForConnector(env, 'plaid')).not.toBe(injected);
  });

  it('saves a rotated Questrade token, applies holdings, lots and activities', async () => {
    await addConnection(connection('conn_qt', 'questrade'));
    await saveCredentials(env, 'conn_qt', {
      QUESTRADE_REFRESH_TOKEN: 'demo-refresh-token-1',
      KEEP_ME: 'still here',
    });
    const report = await syncConnection(env, 'conn_qt', {
      fetch: fakeFetch(questradeRoutes()),
      now: () => NOW,
    });
    expect(report.outcome).toBe('ok');
    expect(await loadCredentials(env, 'conn_qt')).toEqual({
      QUESTRADE_REFRESH_TOKEN: 'demo-refresh-token-2',
      KEEP_ME: 'still here',
    });
    const holdings = await selectAll(db, holdingsTable);
    const lots = await selectAll(db, taxLotsTable);
    const acts = await selectAll(db, activitiesTable);
    expect(holdings.length).toBeGreaterThan(0);
    expect(lots.length).toBeGreaterThan(0);
    expect(acts.length).toBeGreaterThan(0);
    expect(report.summary?.holdings).toBe(holdings.length);
    // every lot belongs to a stored holding
    const ids = new Set(holdings.map((h) => h.id));
    expect(lots.every((l) => ids.has(l.holdingId))).toBe(true);

    // a second run keeps the same rows
    await syncConnection(env, 'conn_qt', {
      fetch: fakeFetch({
        ...questradeRoutes(),
        'POST login.questrade.com/oauth2/token': {
          ...qtToken,
          refresh_token: 'demo-refresh-token-3',
        },
      }),
      now: () => NOW,
    });
    expect(await selectAll(db, holdingsTable)).toHaveLength(holdings.length);
    expect(await selectAll(db, taxLotsTable)).toHaveLength(lots.length);
    expect(await selectAll(db, activitiesTable)).toHaveLength(acts.length);
    expect((await loadCredentials(env, 'conn_qt')).QUESTRADE_REFRESH_TOKEN).toBe(
      'demo-refresh-token-3',
    );
  });

  it('marks an expired login needs_repair, and the next run does not call the provider', async () => {
    await addConnection(connection('conn_sf', 'simplefin'));
    await saveCredentials(env, 'conn_sf', { SIMPLEFIN_ACCESS_URL: SF_URL });
    const dead = fakeFetch({
      'GET bridge.example.invalid/simplefin/accounts': { status: 403, json: {} },
    });
    const report = await syncConnection(env, 'conn_sf', { fetch: dead, now: () => NOW });
    expect(report).toMatchObject({ outcome: 'needs_repair', status: 'needs_repair' });
    const conn = await selectOne(db, connectionsTable, 'id = ?', ['conn_sf']);
    expect(conn?.status).toBe('needs_repair');
    expect(conn?.lastError).toBeTruthy();

    const again = fakeFetch({});
    const second = await syncConnection(env, 'conn_sf', { fetch: again, now: () => NOW });
    expect(second).toMatchObject({ outcome: 'skipped', skippedBecause: 'needs_repair' });
    expect(again.calls).toHaveLength(0);
  });

  it('force syncs a repaired connection and brings it back to healthy', async () => {
    await addConnection(connection('conn_sf', 'simplefin', { status: 'needs_repair' }));
    await saveCredentials(env, 'conn_sf', { SIMPLEFIN_ACCESS_URL: SF_URL });
    const report = await syncConnection(env, 'conn_sf', {
      fetch: fakeFetch(sfRoutes()),
      now: () => NOW,
      force: true,
    });
    expect(report).toMatchObject({ outcome: 'ok', status: 'healthy' });
  });

  it('records a missing CREDENTIALS_SECRET as an error without losing data', async () => {
    await addConnection(connection('conn_sf', 'simplefin'));
    await saveCredentials(env, 'conn_sf', { SIMPLEFIN_ACCESS_URL: SF_URL });
    const report = await syncConnection({ ...env, CREDENTIALS_SECRET: undefined }, 'conn_sf', {
      fetch: fakeFetch(sfRoutes()),
      now: () => NOW,
    });
    expect(report.outcome).toBe('error');
    expect(report.error).toMatch(/CREDENTIALS_SECRET/);
  });
});

describe('property values refresh at most monthly', () => {
  const routes = () => ({ 'GET api.rentcast.io/v1/avm/value': rentcastAvm });
  const withKey = { ...env, RENTCAST_API_KEY: 'rc_test_key' } as Env;

  it('syncs the first time, skips for 30 days, then syncs again', async () => {
    await addConnection(connection('conn_rc', 'rentcast'));
    await saveCredentials(withKey, 'conn_rc', { RENTCAST_ADDRESS: '1 Example St, Austin, TX' });
    const f1 = fakeFetch(routes());
    const first = await syncConnection(withKey, 'conn_rc', { fetch: f1, now: () => NOW });
    expect(first.outcome).toBe('ok');
    expect(f1.calls).toHaveLength(1);
    expect(f1.calls[0]?.headers['X-Api-Key']).toBe('rc_test_key');

    const tenDays = new Date(NOW.getTime() + 10 * 86_400_000);
    const f2 = fakeFetch(routes());
    const skipped = await syncConnection(withKey, 'conn_rc', { fetch: f2, now: () => tenDays });
    expect(skipped).toMatchObject({ outcome: 'skipped', skippedBecause: 'valuation_recent' });
    expect(f2.calls).toHaveLength(0);

    const forced = fakeFetch(routes());
    expect(
      (await syncConnection(withKey, 'conn_rc', { fetch: forced, now: () => tenDays, force: true }))
        .outcome,
    ).toBe('ok');

    const later = new Date(NOW.getTime() + 41 * 86_400_000); // 31 days after the forced refresh
    const f3 = fakeFetch(routes());
    expect(
      (await syncConnection(withKey, 'conn_rc', { fetch: f3, now: () => later })).outcome,
    ).toBe('ok');
    expect(f3.calls).toHaveLength(1);
  });
});

describe('daily sync of all connections', () => {
  it('syncs healthy and errored connections, skips needs_repair and disconnected ones', async () => {
    await addConnection(connection('conn_ok', 'simplefin'));
    await addConnection(
      connection('conn_err', 'simplefin', { status: 'error', lastError: 'timeout' }),
    );
    await addConnection(connection('conn_dead', 'simplefin', { status: 'needs_repair' }));
    await addConnection(connection('conn_off', 'simplefin', { status: 'disconnected' }));
    for (const id of ['conn_ok', 'conn_err', 'conn_dead', 'conn_off']) {
      await saveCredentials(env, id, {
        SIMPLEFIN_ACCESS_URL: `https://token_${id}:pw@bridge.example.invalid/simplefin`,
      });
    }
    const fetch = fakeFetch(sfRoutes());
    // The retry reset is another budgeted write. Follow the cron across invocations
    // rather than requiring every connection to fit into the same Free-plan allowance.
    const reports = [];
    for (let run = 0; run < 2; run += 1) {
      const meter = meterDb(db);
      reports.push(...(await syncDueConnections(env, { fetch, now: () => NOW, meter })));
      expect(meter.used()).toBeLessThanOrEqual(D1_QUERIES_PER_INVOCATION);
    }
    expect(reports.map((r) => r.connectionId).sort()).toEqual(['conn_err', 'conn_ok']);
    const users = new Set(
      fetch.calls.map((c) => atob((c.headers.Authorization ?? '').replace('Basic ', ''))),
    );
    expect(users).toEqual(new Set(['token_conn_ok:pw', 'token_conn_err:pw']));
    const statuses = Object.fromEntries(
      (await selectAll(db, connectionsTable)).map((c) => [c.id, c.status]),
    );
    expect(statuses).toEqual({
      conn_ok: 'healthy',
      conn_err: 'healthy',
      conn_dead: 'needs_repair',
      conn_off: 'disconnected',
    });
  });

  it('one failing connection does not stop the others', async () => {
    await addConnection(connection('conn_a', 'simplefin'));
    await addConnection(connection('conn_b', 'simplefin'));
    await saveCredentials(env, 'conn_a', {
      SIMPLEFIN_ACCESS_URL: 'https://bad:pw@bridge.example.invalid/simplefin',
    });
    await saveCredentials(env, 'conn_b', {
      SIMPLEFIN_ACCESS_URL: 'https://good:pw@bridge.example.invalid/simplefin',
    });
    const fetch = fakeFetch({
      'GET bridge.example.invalid/simplefin/accounts': (_url: URL, init?: RequestInit) => {
        const auth = String((init?.headers as Record<string, string>).Authorization);
        return atob(auth.replace('Basic ', '')) === 'bad:pw'
          ? { status: 500, json: { error: 'boom' } }
          : sfAccounts;
      },
    });
    const reports = await syncAllConnections(env, { fetch, now: () => NOW });
    expect(Object.fromEntries(reports.map((r) => [r.connectionId, r.outcome]))).toEqual({
      conn_a: 'error',
      conn_b: 'ok',
    });
  });
});

describe('the sync route', () => {
  it('answers 502 with the report when the provider fails and 200 when it works', async () => {
    const { client } = await import('./worker');
    await addConnection(connection('conn_sf', 'simplefin'));
    await saveCredentials(env, 'conn_sf', { SIMPLEFIN_ACCESS_URL: SF_URL });
    const bad = await client({ fetch: fakeFetch({}) }, env).api(
      'POST',
      '/v1/connections/conn_sf/sync',
    );
    expect(bad.status).toBe(502);
    const good = await client({ fetch: fakeFetch(sfRoutes()) }, env).api(
      'POST',
      '/v1/connections/conn_sf/sync',
    );
    expect(good.status).toBe(200);
    expect((good.body as { outcome: string }).outcome).toBe('ok');
    const missing = await client({}, env).api('POST', '/v1/connections/nope/sync');
    expect(missing.status).toBe(404);
  });
});

describe('reserved account-linking callbacks', () => {
  it('answers the Zerodha Kite redirect path without a token, and refuses it without a valid state', async () => {
    const { client } = await import('./worker');
    const res = await client().raw(
      '/v1/link/zerodha_kite/callback?request_token=abc&status=success&action=login',
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/expired/);
  });

  it('keeps every other /v1 path behind the token, including look-alike link paths', async () => {
    const { client } = await import('./worker');
    for (const path of [
      '/v1/link/zerodha_kite/callback/extra',
      '/v1/link/sophtron/callback',
      '/v1/link/zerodha_kite',
      '/v1/link/zerodha_kite/start',
      '/v1/accounts',
    ]) {
      expect((await client().api('GET', path, undefined, null)).status, path).toBe(401);
    }
  });
});
