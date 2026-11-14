import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection, LinkOptionsResponse, SophtronLinkStatus } from '@manaclaude/shared';
import kiteSession from '../../connectors/fixtures/zerodha_kite/session_token.json';
import sophtronAccounts from '../../connectors/fixtures/sophtron/accounts.json';
import sophtronTxns1 from '../../connectors/fixtures/sophtron/transactions_001.json';
import sophtronTxns2 from '../../connectors/fixtures/sophtron/transactions_002.json';
import { insertStatement, selectAll, selectOne } from '../src/db/table';
import { connectionsTable } from '../src/db/tables';
import type { Env } from '../src/env';
import { loadCredentials, saveCredentials } from '../src/sync/credentials';
import { signState } from '../src/link/state';
import { freshDb, testEnv } from './helpers';
import { client } from './worker';

// Every key, token, password and URL below is invented for these tests.
const SECRETS = {
  bankPassword: 'demo-bank-password-7f3a',
  bankUser: 'demo-bank-user-91',
  sophtronKey: btoa('demo-sophtron-access-key-0123456'),
  simplefinAccess: 'https://demo-sf-user:demo-sf-pass-55@bridge.example.invalid/simplefin',
  snapSecret: 'demo-snaptrade-user-secret-42',
  snapConsumer: 'demo-snaptrade-consumer-key-77',
  kiteSecret: 'demo-kite-api-secret-31',
  kiteAccess: kiteSession.data.access_token,
  plaidSecret: 'demo-plaid-secret-64',
  plaidAccess: 'access-demo-plaid-token-8812',
  plaidPublic: 'public-demo-plaid-token-1100',
  coinbaseSecret: 'demo-coinbase-secret-0099aa',
  wazirxSecret: 'demo-wazirx-secret-55bb22',
};

const env: Env = {
  ...testEnv,
  CREDENTIALS_SECRET: 'test-credentials-secret-0123456789',
  PUBLIC_URL: 'https://manaclaude-api.demo.workers.dev',
  SOPHTRON_USER_ID: 'demo-user-0001',
  SOPHTRON_ACCESS_KEY: SECRETS.sophtronKey,
  SNAPTRADE_CLIENT_ID: 'DEMO-CLIENT',
  SNAPTRADE_CONSUMER_KEY: SECRETS.snapConsumer,
  KITE_API_KEY: 'demo_kite_key',
  KITE_API_SECRET: SECRETS.kiteSecret,
  PLAID_CLIENT_ID: 'demo-plaid-client',
  PLAID_SECRET: SECRETS.plaidSecret,
  PLAID_ENV: 'sandbox',
};
const db = env.DB;
const NOW = new Date('2026-11-05T12:00:00.000Z');

type Reply = { status?: number; json?: unknown; text?: string };
type Handler = Reply | ((url: URL, body: string) => Reply);

/** A fetch that answers from routes ("METHOD host/path") and records every call. */
function fakeFetch(routes: Record<string, Handler>) {
  const calls: { method: string; url: URL; body: string }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({ method, url, body });
    const h = routes[`${method} ${url.host}${url.pathname}`];
    if (!h) return new Response('{"error":"no route"}', { status: 404 });
    const r = typeof h === 'function' ? h(url, body) : h;
    return new Response(r.text ?? JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
  }) as typeof fetch;
  return Object.assign(fn, { calls });
}

const SOPH = 'api.sophtron.com';
function sophtronRoutes(jobs: Reply[]) {
  let polls = 0;
  return {
    [`POST ${SOPH}/api/Institution/GetInstitutionByName`]: {
      json: {
        Institutions: [{ InstitutionID: 'inst-1', InstitutionName: 'Summit Card Services' }],
      },
    },
    [`POST ${SOPH}/api/UserInstitution/CreateUserInstitution`]: {
      json: { JobID: 'job-1', UserInstitutionID: 'ui-555' },
    },
    [`POST ${SOPH}/api/Job/GetJobInformationByID`]: () => jobs[Math.min(polls++, jobs.length - 1)]!,
    [`POST ${SOPH}/api/Job/UpdateJobSecurityAnswer`]: { json: {} },
    [`POST ${SOPH}/api/UserInstitution/GetUserInstitutionAccounts`]: { json: sophtronAccounts },
    [`POST ${SOPH}/api/UserInstitutionAccount/RefreshUserInstitutionAccount`]: {
      json: { JobID: 'job-refresh' },
    },
    [`POST ${SOPH}/api/Transaction/GetTransactionsByTransactionDate`]: (_u: URL, body: string) => ({
      json: JSON.parse(body).AccountID === 'soph-acc-001' ? sophtronTxns1 : sophtronTxns2,
    }),
  } satisfies Record<string, Handler>;
}

// ---- leak watch: every response body and console line is kept and scanned ----
const seen: string[] = [];
let spies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(async () => {
  await freshDb();
  seen.length = 0;
  spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      seen.push(
        args.map((a) => (a instanceof Error ? `${a.name} ${a.message}` : String(a))).join(' '),
      );
    }),
  );
});
afterEach(() => {
  for (const s of spies) s.mockRestore();
});

function api(fetch?: typeof globalThis.fetch, e: Env = env, now: () => Date = () => NOW) {
  const c = client({ fetch, now }, e);
  return {
    async call<T = Record<string, unknown>>(method: string, path: string, body?: unknown) {
      const res = await c.api<T>(method, path, body);
      seen.push(JSON.stringify(res.body));
      return res;
    },
    async raw(path: string) {
      const res = await c.raw(path, { redirect: 'manual' });
      const text = await res.text();
      seen.push(text, res.headers.get('location') ?? '');
      return { status: res.status, text, location: res.headers.get('location') };
    },
  };
}

async function expectNoLeaks() {
  const rows: string[] = [];
  for (const table of ['connections', 'link_sessions', 'accounts', 'connector_slots']) {
    rows.push(JSON.stringify((await db.prepare(`SELECT * FROM ${table}`).all()).results));
  }
  rows.push(
    JSON.stringify((await db.prepare('SELECT * FROM connection_credentials').all()).results),
  );
  const haystack = [...seen, ...rows].join('\n');
  for (const [name, value] of Object.entries(SECRETS)) {
    expect(haystack.includes(value), `${name} leaked`).toBe(false);
  }
}

async function addConnection(over: Partial<Connection> & Pick<Connection, 'id' | 'connectorId'>) {
  await insertStatement(db, connectionsTable, {
    institutionName: 'Demo',
    status: 'healthy',
    lastSyncAt: null,
    lastSuccessfulSyncAt: null,
    lastError: null,
    syncCursor: null,
    accountIds: [],
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  }).run();
}

const slots = async () =>
  Object.fromEntries(
    (
      await db
        .prepare('SELECT connector_id, used FROM connector_slots')
        .all<{ connector_id: string; used: number }>()
    ).results.map((r) => [r.connector_id, r.used]),
  );

describe('link options', () => {
  it('offers the new order, never Teller, keeps Plaid off, and says only yes or no about keys', async () => {
    const res = await api().call<LinkOptionsResponse>('GET', '/v1/link/options');
    expect(res.status).toBe(200);
    expect(res.body.order).toEqual({
      bank: ['sophtron', 'simplefin', 'plaid'],
      brokerage: ['snaptrade', 'zerodha_kite', 'sophtron'],
      crypto: ['coinbase', 'wazirx'],
    });
    expect(res.body.connectors.map((c) => c.id)).not.toContain('teller');
    const plaid = res.body.connectors.find((c) => c.id === 'plaid');
    expect(plaid).toMatchObject({ configured: false, slots: { total: 10, left: 10 } });
    expect(plaid?.blockedReason).toMatch(/off until you say so/);
    expect(res.body.connectors.find((c) => c.id === 'sophtron')?.configured).toBe(true);
    expect(res.body.plaidEnabled).toBe(false);
    await expectNoLeaks();
  });

  it('says what is missing when a connector has no keys', async () => {
    const bare = { ...env, SOPHTRON_USER_ID: undefined, SOPHTRON_ACCESS_KEY: undefined };
    const res = await api(undefined, bare).call<LinkOptionsResponse>('GET', '/v1/link/options');
    expect(res.body.connectors.find((c) => c.id === 'sophtron')?.blockedReason).toMatch(
      /SOPHTRON_USER_ID and SOPHTRON_ACCESS_KEY/,
    );
    const start = await api(undefined, bare).call('POST', '/v1/link/sophtron/institutions', {
      query: 'summit',
    });
    expect(start.status).toBe(503);
  });

  it('keeps every link route behind the token except the two browser callbacks', async () => {
    const c = client({}, env);
    for (const path of [
      '/v1/link/options',
      '/v1/link/sophtron/callback',
      '/v1/link/plaid/callback',
    ]) {
      expect((await c.api('GET', path, undefined, null)).status, path).toBe(401);
    }
    const kite = await c.raw('/v1/link/zerodha_kite/callback?request_token=x&status=success');
    expect(kite.status).toBe(400);
    const snap = await c.raw('/v1/link/snaptrade/callback');
    expect(snap.status).toBe(400);
  });
});

describe('Sophtron', () => {
  it('persists and replays a refresh that completes immediately without a job', async () => {
    await addConnection({ id: 'conn_soph', connectorId: 'sophtron', status: 'needs_repair' });
    await saveCredentials(env, 'conn_soph', { SOPHTRON_USER_INSTITUTION_ID: 'ui-555' });
    const fetch = fakeFetch({
      ...sophtronRoutes([]),
      [`POST ${SOPH}/api/UserInstitutionAccount/RefreshUserInstitutionAccount`]: { json: {} },
    });
    const a = api(fetch);
    const done = await a.call<SophtronLinkStatus>('POST', '/v1/link/sophtron/start', {
      connectionId: 'conn_soph',
      refresh: true,
    });
    expect(done.body).toEqual({
      linkId: expect.stringMatching(/^link_/),
      status: 'done',
      connectionIds: ['conn_soph'],
      repaired: true,
    });
    expect((await a.call('GET', `/v1/link/sophtron/${done.body.linkId}`)).body).toEqual(done.body);
    expect(fetch.calls).toHaveLength(2);
    expect(await slots()).toEqual({});
  });
  it('signs in, answers the security question, saves only the login id, then syncs', async () => {
    const fetch = fakeFetch(
      sophtronRoutes([
        { json: { LastStatus: 'Started' } },
        { json: { SecurityQuestion: '["What was the name of your first pet?"]' } },
        { json: { SuccessFlag: true, LastStatus: 'AccountsReady' } },
      ]),
    );
    const a = api(fetch);
    const found = await a.call('POST', '/v1/link/sophtron/institutions', { query: 'summit' });
    expect(found.body).toEqual({
      institutions: [{ id: 'inst-1', name: 'Summit Card Services', url: null }],
    });
    const start = await a.call<SophtronLinkStatus>('POST', '/v1/link/sophtron/start', {
      institutionId: 'inst-1',
      institutionName: 'Summit Card Services',
      username: SECRETS.bankUser,
      password: SECRETS.bankPassword,
    });
    expect(start.body.status).toBe('pending');
    const linkId = start.body.linkId;
    const mfa = await a.call<SophtronLinkStatus>('GET', `/v1/link/sophtron/${linkId}`);
    expect(mfa.body).toMatchObject({
      status: 'mfa',
      challenge: { securityQuestions: ['What was the name of your first pet?'] },
    });
    const answered = await a.call('POST', `/v1/link/sophtron/${linkId}/answer`, {
      type: 'security_answer',
      answers: ['Rex'],
    });
    expect(answered.body).toEqual({ linkId, status: 'pending' });
    const done = await a.call<SophtronLinkStatus>('GET', `/v1/link/sophtron/${linkId}`);
    expect(done.body).toMatchObject({ status: 'done', repaired: false });
    const connectionId = done.body.connectionIds?.[0] ?? '';

    const conn = await selectOne(db, connectionsTable, 'id = ?', [connectionId]);
    expect(conn).toMatchObject({
      connectorId: 'sophtron',
      status: 'syncing',
      institutionName: 'Summit Card Services',
    });
    expect(await loadCredentials(env, connectionId)).toEqual({
      SOPHTRON_USER_INSTITUTION_ID: 'ui-555',
    });
    expect(await slots()).toEqual({ sophtron: 1 });
    // The password went to Sophtron once, in the sign-in request, and nowhere else.
    const withPassword = fetch.calls.filter((c) => c.body.includes(SECRETS.bankPassword));
    expect(withPassword.map((c) => c.url.pathname)).toEqual([
      '/api/UserInstitution/CreateUserInstitution',
    ]);

    // Polling again after it finished changes nothing.
    const again = await a.call<SophtronLinkStatus>('GET', `/v1/link/sophtron/${linkId}`);
    expect(again.body).toEqual(done.body);
    expect(await selectAll(db, connectionsTable)).toHaveLength(1);
    expect(await slots()).toEqual({ sophtron: 1 });

    const sync = await a.call<{ outcome: string; more: boolean }>(
      'POST',
      `/v1/connections/${connectionId}/sync`,
    );
    expect(sync.body).toMatchObject({ outcome: 'ok', more: false });
    expect((await selectOne(db, connectionsTable, 'id = ?', [connectionId]))?.status).toBe(
      'healthy',
    );
    await expectNoLeaks();
  });

  it('repairs by answering the bank again on the same login: same id, no new slot', async () => {
    await addConnection({
      id: 'conn_soph',
      connectorId: 'sophtron',
      status: 'needs_repair',
      lastError: 'x',
    });
    await saveCredentials(env, 'conn_soph', { SOPHTRON_USER_INSTITUTION_ID: 'ui-555' });
    const fetch = fakeFetch(
      sophtronRoutes([{ json: { TokenSentFlag: true } }, { json: { SuccessFlag: true } }]),
    );
    const a = api(fetch);
    const start = await a.call<SophtronLinkStatus>('POST', '/v1/link/sophtron/start', {
      connectionId: 'conn_soph',
      refresh: true,
    });
    expect(start.body).toMatchObject({ status: 'mfa', challenge: { tokenSent: true } });
    await a.call('POST', `/v1/link/sophtron/${start.body.linkId}/answer`, {
      type: 'token_input',
      code: '123456',
    });
    const done = await a.call<SophtronLinkStatus>('GET', `/v1/link/sophtron/${start.body.linkId}`);
    expect(done.body).toMatchObject({
      status: 'done',
      connectionIds: ['conn_soph'],
      repaired: true,
    });
    expect(await selectOne(db, connectionsTable, 'id = ?', ['conn_soph'])).toMatchObject({
      status: 'syncing',
      lastError: null,
    });
    expect(await slots()).toEqual({});
    expect(fetch.calls.some((c) => c.url.pathname.endsWith('CreateUserInstitution'))).toBe(false);
  });

  it('reports a failed sign-in plainly', async () => {
    const fetch = fakeFetch(
      sophtronRoutes([{ json: { SuccessFlag: false, LastStatus: 'Failed' } }]),
    );
    const start = await api(fetch).call<SophtronLinkStatus>('POST', '/v1/link/sophtron/start', {
      institutionId: 'inst-1',
      username: SECRETS.bankUser,
      password: SECRETS.bankPassword,
    });
    expect(start.body).toMatchObject({
      status: 'failed',
      message: expect.stringMatching(/did not accept/),
    });
    expect(await selectAll(db, connectionsTable)).toHaveLength(0);
    await expectNoLeaks();
  });
});

describe('SimpleFIN', () => {
  const claim = 'https://bridge.example.invalid/simplefin/claim/demo-claim-0001';
  const token = btoa(claim);

  it('claims the setup token, saves the access URL encrypted, and never shows it', async () => {
    const fetch = fakeFetch({
      'POST bridge.example.invalid/simplefin/claim/demo-claim-0001': {
        text: SECRETS.simplefinAccess,
      },
    });
    const res = await api(fetch).call<{ connectionIds: string[]; repaired: boolean }>(
      'POST',
      '/v1/link/simplefin',
      { setupToken: token },
    );
    expect(res.status).toBe(201);
    expect(res.body.repaired).toBe(false);
    const id = res.body.connectionIds[0]!;
    expect(await loadCredentials(env, id)).toEqual({
      SIMPLEFIN_ACCESS_URL: SECRETS.simplefinAccess,
    });
    await expectNoLeaks();
  });

  it('explains a token that was already used', async () => {
    const fetch = fakeFetch({
      'POST bridge.example.invalid/simplefin/claim/demo-claim-0001': { status: 403 },
    });
    const res = await api(fetch).call('POST', '/v1/link/simplefin', { setupToken: token });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: 'link_input',
      message: expect.stringMatching(/already used/),
    });
    const junk = await api(fetch).call('POST', '/v1/link/simplefin', {
      setupToken: 'not a setup token at all, just words',
    });
    expect(junk.status).toBe(400);
    expect(await selectAll(db, connectionsTable)).toHaveLength(0);
  });
});

describe('SnapTrade', () => {
  const ST = 'api.snaptrade.com';
  function routes(auths: unknown[]) {
    return {
      [`POST ${ST}/api/v1/snapTrade/registerUser`]: (_u: URL, body: string) => ({
        json: { userId: JSON.parse(body).userId, userSecret: SECRETS.snapSecret },
      }),
      [`POST ${ST}/api/v1/snapTrade/login`]: {
        json: { redirectURI: 'https://app.snaptrade.example/connect?session=demo-portal' },
      },
      [`GET ${ST}/api/v1/authorizations`]: { json: auths },
    } satisfies Record<string, Handler>;
  }

  it('registers the user once, opens the portal, and records each new authorization', async () => {
    const fetch = fakeFetch(
      routes([
        { id: 'auth-rh', brokerage: { name: 'Robinhood' }, disabled: false },
        { id: 'auth-old', brokerage: { name: 'Old Broker' }, disabled: true },
      ]),
    );
    const a = api(fetch);
    const start = await a.call<{ linkId: string; url: string }>(
      'POST',
      '/v1/link/snaptrade/start',
      {
        returnUrl: 'billionaire://link',
      },
    );
    expect(start.body.url).toBe('https://app.snaptrade.example/connect?session=demo-portal');
    const login = fetch.calls.find((c) => c.url.pathname.endsWith('/login'));
    const redirect = new URL(JSON.parse(login?.body ?? '{}').customRedirect);
    expect(redirect.origin + redirect.pathname).toBe(
      'https://manaclaude-api.demo.workers.dev/v1/link/snaptrade/callback',
    );

    // The browser comes back through the callback and on to the app.
    const back = await a.raw(`/v1/link/snaptrade/callback?${redirect.searchParams.toString()}`);
    expect(back.status).toBe(302);
    expect(back.location).toMatch(/^billionaire:\/\/link\?link=snaptrade&status=ok/);

    const done = await a.call<{ connectionIds: string[] }>(
      'POST',
      `/v1/link/snaptrade/${start.body.linkId}/complete`,
    );
    expect(done.status).toBe(201);
    const [id] = done.body.connectionIds;
    expect(await loadCredentials(env, id!)).toEqual({
      SNAPTRADE_USER_ID: expect.stringMatching(/^billionaire_/),
      SNAPTRADE_USER_SECRET: SECRETS.snapSecret,
      SNAPTRADE_AUTHORIZATION_ID: 'auth-rh',
    });
    expect((await selectOne(db, connectionsTable, 'id = ?', [id!]))?.institutionName).toBe(
      'Robinhood',
    );
    expect(await slots()).toEqual({ snaptrade: 1 });

    // A second link reuses the SnapTrade user and finds nothing new until another brokerage is added.
    const again = await a.call<{ linkId: string }>('POST', '/v1/link/snaptrade/start', {});
    const none = await a.call('POST', `/v1/link/snaptrade/${again.body.linkId}/complete`);
    expect(none.status).toBe(409);
    expect(fetch.calls.filter((c) => c.url.pathname.endsWith('/registerUser'))).toHaveLength(1);
    await expectNoLeaks();
  });

  it('repairs with reconnect set to the same authorization', async () => {
    await addConnection({ id: 'conn_st', connectorId: 'snaptrade', status: 'needs_repair' });
    await saveCredentials(env, 'conn_st', {
      SNAPTRADE_USER_ID: 'billionaire_demo',
      SNAPTRADE_USER_SECRET: SECRETS.snapSecret,
      SNAPTRADE_AUTHORIZATION_ID: 'auth-rh',
    });
    await saveCredentials(env, 'app_snaptrade_user', {
      SNAPTRADE_USER_ID: 'billionaire_demo',
      SNAPTRADE_USER_SECRET: SECRETS.snapSecret,
    });
    const fetch = fakeFetch(
      routes([{ id: 'auth-rh', brokerage: { name: 'Robinhood' }, disabled: false }]),
    );
    const a = api(fetch);
    const start = await a.call<{ linkId: string }>('POST', '/v1/link/snaptrade/start', {
      connectionId: 'conn_st',
    });
    const login = fetch.calls.find((c) => c.url.pathname.endsWith('/login'));
    expect(JSON.parse(login?.body ?? '{}').reconnect).toBe('auth-rh');
    const done = await a.call('POST', `/v1/link/snaptrade/${start.body.linkId}/complete`);
    expect(done.body).toEqual({ connectionIds: ['conn_st'], repaired: true });
    expect((await selectOne(db, connectionsTable, 'id = ?', ['conn_st']))?.status).toBe('syncing');
    expect(await slots()).toEqual({});
  });
});

describe('Zerodha Kite', () => {
  const kiteRoutes = () => ({ 'POST api.kite.trade/session/token': { json: kiteSession } });

  it('logs in through a signed state, saves the token, and sends the browser back to the app', async () => {
    const fetch = fakeFetch(kiteRoutes());
    const a = api(fetch);
    const start = await a.call<{ url: string }>('POST', '/v1/link/zerodha_kite/start', {
      returnUrl: 'billionaire://link',
    });
    const login = new URL(start.body.url);
    expect(login.origin).toBe('https://kite.zerodha.com');
    expect(login.searchParams.get('api_key')).toBe('demo_kite_key');
    const state = new URLSearchParams(login.searchParams.get('redirect_params') ?? '').get('state');
    expect(state).toMatch(/^link_[a-f0-9]{32}\.\d+\.[\w-]+$/);

    const back = await a.raw(
      `/v1/link/zerodha_kite/callback?request_token=demo-request-token&action=login&status=success&state=${state}`,
    );
    expect(back.status).toBe(302);
    expect(back.location).toMatch(/^billionaire:\/\/link\?link=zerodha_kite&status=ok/);
    const conn = (await selectAll(db, connectionsTable))[0]!;
    expect(conn).toMatchObject({
      connectorId: 'zerodha_kite',
      status: 'syncing',
      institutionName: 'Zerodha',
    });
    expect(await loadCredentials(env, conn.id)).toEqual({ KITE_ACCESS_TOKEN: SECRETS.kiteAccess });
    const exchange = fetch.calls.find((c) => c.url.pathname === '/session/token');
    expect(new URLSearchParams(exchange?.body).get('request_token')).toBe('demo-request-token');

    // The same callback again is refused (single use).
    const replay = await a.raw(
      `/v1/link/zerodha_kite/callback?request_token=demo-request-token&action=login&status=success&state=${state}`,
    );
    expect(replay.status).toBe(400);
    await expectNoLeaks();
  });

  it('the daily re-login reuses the Zerodha connection and no slot', async () => {
    await addConnection({ id: 'conn_kite', connectorId: 'zerodha_kite', status: 'needs_repair' });
    await saveCredentials(env, 'conn_kite', { KITE_ACCESS_TOKEN: 'yesterday' });
    const a = api(fakeFetch(kiteRoutes()));
    const start = await a.call<{ url: string }>('POST', '/v1/link/zerodha_kite/start', {
      connectionId: 'conn_kite',
    });
    const state = new URLSearchParams(
      new URL(start.body.url).searchParams.get('redirect_params') ?? '',
    ).get('state');
    const back = await a.raw(
      `/v1/link/zerodha_kite/callback?request_token=t2&action=login&status=success&state=${state}`,
    );
    expect(back.status).toBe(200);
    expect(back.text).toMatch(/Zerodha is connected/);
    expect(await selectAll(db, connectionsTable)).toHaveLength(1);
    expect((await loadCredentials(env, 'conn_kite')).KITE_ACCESS_TOKEN).toBe(SECRETS.kiteAccess);
    expect(await slots()).toEqual({});
  });

  it('expires a login using the injected clock, including across midnight', async () => {
    let now = new Date('2030-12-31T23:55:00.000Z');
    const fetch = fakeFetch(kiteRoutes());
    const a = api(fetch, env, () => now);
    const start = await a.call<{ url: string }>('POST', '/v1/link/zerodha_kite/start');
    expect(start.status).toBe(200);
    const state = new URLSearchParams(
      new URL(start.body.url).searchParams.get('redirect_params') ?? '',
    ).get('state')!;
    expect(Number(state.split('.')[1]) * 1000).toBe(Date.parse('2031-01-01T00:05:00.000Z'));
    now = new Date('2031-01-01T00:05:01.000Z');
    const back = await a.raw(
      `/v1/link/zerodha_kite/callback?request_token=expired&status=success&state=${state}`,
    );
    expect(back.status).toBe(400);
    expect(fetch.calls).toHaveLength(0);
    expect(await selectAll(db, connectionsTable)).toHaveLength(0);
  });

  it('refuses a forged, tampered or expired state and drops foreign return addresses', async () => {
    const fetch = fakeFetch(kiteRoutes());
    const a = api(fetch);
    const start = await a.call<{ linkId: string; url: string }>(
      'POST',
      '/v1/link/zerodha_kite/start',
      {
        returnUrl: 'https://evil.example.com/steal',
      },
    );
    const state = new URLSearchParams(
      new URL(start.body.url).searchParams.get('redirect_params') ?? '',
    ).get('state')!;
    const [linkId, exp, sig] = state.split('.');
    const forged = await signState(
      { ...env, CREDENTIALS_SECRET: 'someone-else' },
      linkId!,
      new Date(Number(exp) * 1000),
    );
    const expired = await signState(env, linkId!, new Date(NOW.getTime() - 1000));
    for (const bad of [forged, `${linkId}.${Number(exp) + 600}.${sig}`, expired, 'garbage']) {
      const res = await a.raw(
        `/v1/link/zerodha_kite/callback?request_token=t&status=success&state=${encodeURIComponent(bad)}`,
      );
      expect(res.status, bad).toBe(400);
    }
    expect(fetch.calls).toHaveLength(0);
    // The real state works, and the foreign return address was never kept.
    const ok = await a.raw(
      `/v1/link/zerodha_kite/callback?request_token=t&status=success&state=${state}`,
    );
    expect(ok.status).toBe(200);
    expect(ok.location).toBeNull();
  });
});

describe('Plaid (invented responses only)', () => {
  const plaidRoutes = () => ({
    'POST sandbox.plaid.com/link/token/create': {
      json: { link_token: 'link-sandbox-demo-1', expiration: '2026-11-05T16:00:00Z' },
    },
    'POST sandbox.plaid.com/item/public_token/exchange': {
      json: { access_token: SECRETS.plaidAccess, item_id: 'item-demo-1' },
    },
  });

  it('is off by default and never calls Plaid', async () => {
    const fetch = fakeFetch(plaidRoutes());
    const a = api(fetch);
    const token = await a.call('POST', '/v1/link/plaid/link-token', { platform: 'android' });
    expect(token.status).toBe(409);
    expect(token.body).toMatchObject({ error: 'plaid_off' });
    const exchange = await a.call('POST', '/v1/link/plaid/exchange', {
      publicToken: SECRETS.plaidPublic,
    });
    expect(exchange.status).toBe(409);
    expect(fetch.calls).toHaveLength(0);
  });

  it('when turned on: link token for Android, exchange, one lifetime slot', async () => {
    const on = { ...env, PLAID_LINK_ENABLED: 'true' };
    const fetch = fakeFetch(plaidRoutes());
    const a = api(fetch, on);
    const token = await a.call('POST', '/v1/link/plaid/link-token', { platform: 'android' });
    expect(token.body).toEqual({
      linkToken: 'link-sandbox-demo-1',
      expiration: '2026-11-05T16:00:00Z',
    });
    expect(JSON.parse(fetch.calls[0]!.body).android_package_name).toBe('com.reddyai.manaclaude');
    const ex = await a.call<{ connectionIds: string[] }>('POST', '/v1/link/plaid/exchange', {
      publicToken: SECRETS.plaidPublic,
      institutionName: 'Harbor Savings Bank',
    });
    expect(ex.status).toBe(201);
    const id = ex.body.connectionIds[0]!;
    expect(await loadCredentials(env, id)).toEqual({
      PLAID_ACCESS_TOKEN: SECRETS.plaidAccess,
      PLAID_ITEM_ID: 'item-demo-1',
    });
    expect(await slots()).toEqual({ plaid: 1 });

    // Update mode for a repair uses the saved access token and spends no slot.
    const repair = await a.call('POST', '/v1/link/plaid/link-token', {
      platform: 'web',
      connectionId: id,
    });
    expect(repair.status).toBe(200);
    expect(JSON.parse(fetch.calls.at(-1)!.body).access_token).toBe(SECRETS.plaidAccess);
    const repaired = await a.call('POST', '/v1/link/plaid/exchange', { connectionId: id });
    expect(repaired.body).toEqual({ connectionIds: [id], repaired: true });
    expect(await slots()).toEqual({ plaid: 1 });
    await expectNoLeaks();
  });

  it('refuses a new Plaid login when all 10 lifetime logins are used', async () => {
    await db.prepare("INSERT INTO connector_slots (connector_id, used) VALUES ('plaid', 10)").run();
    const fetch = fakeFetch(plaidRoutes());
    const res = await api(fetch, { ...env, PLAID_LINK_ENABLED: 'true' }).call(
      'POST',
      '/v1/link/plaid/link-token',
      { platform: 'android' },
    );
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'no_slots' });
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('Coinbase and WazirX keys', () => {
  it('saves a key pair the exchange accepts and refuses one it rejects, without echoing either', async () => {
    const fetch = fakeFetch({
      'GET api.wazirx.com/sapi/v1/funds': { json: [] },
      'GET api.coinbase.com/v2/user': { status: 401, json: { errors: [{ id: 'unauthorized' }] } },
    });
    const a = api(fetch);
    const ok = await a.call<{ connectionIds: string[] }>('POST', '/v1/link/keys', {
      connectorId: 'wazirx',
      apiKey: 'demo-wazirx-key-1234',
      apiSecret: SECRETS.wazirxSecret,
    });
    expect(ok.status).toBe(201);
    expect(await loadCredentials(env, ok.body.connectionIds[0]!)).toEqual({
      WAZIRX_API_KEY: 'demo-wazirx-key-1234',
      WAZIRX_API_SECRET: SECRETS.wazirxSecret,
    });
    const bad = await a.call('POST', '/v1/link/keys', {
      connectorId: 'coinbase',
      apiKey: 'organizations/demo/apiKeys/demo',
      apiSecret: SECRETS.coinbaseSecret,
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(bad.body)).toMatch(/Coinbase/);
    expect((await selectAll(db, connectionsTable)).map((c) => c.connectorId)).toEqual(['wazirx']);
    const teller = await a.call('POST', '/v1/link/keys', {
      connectorId: 'teller',
      apiKey: 'demo-teller-key',
      apiSecret: 'demo-teller-secret',
    });
    expect(teller.status).toBe(400);
    await expectNoLeaks();
  });
});
