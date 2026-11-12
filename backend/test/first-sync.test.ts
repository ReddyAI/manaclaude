import { beforeEach, describe, expect, it } from 'vitest';
import type { Connection } from '@manaclaude/shared';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { insertStatement, selectAll, selectOne } from '../src/db/table';
import {
  accountsTable,
  connectionsTable,
  transactionsTable,
  transferLinksTable,
} from '../src/db/tables';
import { bulkInsertSpecs, bulkUpdateSpecs, chunkRows, runSpecs } from '../src/db/bulk';
import { D1_QUERIES_PER_INVOCATION, meterDb } from '../src/db/meter';
import type { Env } from '../src/env';
import { createWorker, SYNC_CRON } from '../src/worker';
import { saveCredentials } from '../src/sync/credentials';
import { syncDueConnections, type ConnectionSyncReport } from '../src/sync/run';
import { CARD_ID, CHECKING_ID, twoYearsOfSophtron } from './fixtures/sophtronTwoYears';
import { freshDb, testEnv } from './helpers';
import { client } from './worker';

// An invented Sophtron key pair; nothing here is real.
const env: Env = {
  ...testEnv,
  CREDENTIALS_SECRET: 'test-credentials-secret-0123456789',
  SOPHTRON_USER_ID: 'demo-user-0001',
  SOPHTRON_ACCESS_KEY: btoa('demo-sophtron-access-key-0123456'),
};
const db = env.DB;
const NOW = new Date('2026-11-05T12:00:00.000Z');
const data = twoYearsOfSophtron();
const TOTAL = Object.values(data.transactions).reduce((n, list) => n + list.length, 0);

function connection(id: string, over: Partial<Connection> = {}): Connection {
  return {
    id,
    connectorId: 'sophtron',
    institutionName: 'Lakeview Bank',
    status: 'healthy',
    lastSyncAt: null,
    lastSuccessfulSyncAt: null,
    lastError: null,
    syncCursor: null,
    accountIds: [],
    createdAt: '2026-11-05T11:00:00.000Z',
    updatedAt: '2026-11-05T11:00:00.000Z',
    ...over,
  };
}

/** Sophtron answering from the two-year fixture, counting provider calls. */
function sophtronFetch() {
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    calls.push(url.pathname);
    const body = JSON.parse(String(init?.body ?? '{}')) as { AccountID?: string };
    if (url.pathname.endsWith('/GetUserInstitutionAccounts'))
      return Response.json({ Accounts: data.accounts });
    if (url.pathname.endsWith('/GetTransactionsByTransactionDate'))
      return Response.json({ Transactions: data.transactions[body.AccountID ?? ''] ?? [] });
    if (url.pathname.endsWith('/RefreshUserInstitutionAccount')) return Response.json({});
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return Object.assign(fn, { calls });
}

async function addLinkedConnection(id: string, over: Partial<Connection> = {}) {
  await insertStatement(db, connectionsTable, connection(id, over)).run();
  await saveCredentials(env, id, { SOPHTRON_USER_INSTITUTION_ID: `ui-${id}` });
}

/** One POST /v1/connections/:id/sync, as its own invocation, with every D1 query counted. */
async function syncOnce(id: string, fetch: typeof globalThis.fetch) {
  const meter = meterDb(db);
  const res = await client(
    { fetch, now: () => NOW },
    { ...env, DB: meter.db },
  ).api<ConnectionSyncReport>('POST', `/v1/connections/${id}/sync`);
  return { status: res.status, report: res.body, queries: meter.used() };
}

beforeEach(freshDb);

describe('multi-row writes', () => {
  it('cuts rows into chunks by count and by size', () => {
    const rows = Array.from({ length: 1001 }, (_, i) => [i, 'x'.repeat(10)]);
    expect(chunkRows(rows, 400).map((c) => c.rows)).toEqual([400, 400, 201]);
    expect(chunkRows(rows, 5000, 2000).every((c) => c.json.length <= 2000)).toBe(true);
  });

  it('inserts, ignores duplicates, upserts and updates many rows in a few queries', async () => {
    const accounts = Array.from({ length: 900 }, (_, i) => ({
      id: `acc_${i}`,
      name: `Account ${i}`,
      institutionName: i % 2 ? 'Bank "Quoted" ₹' : null,
      type: 'checking' as const,
      subtype: null,
      currency: 'USD',
      balance: i * 100,
      balanceAsOf: NOW.toISOString(),
      availableBalance: null,
      creditLimit: null,
      mask: null,
      connectionId: null,
      externalId: null,
      includeInNetWorth: i % 3 === 0,
      hidden: false,
      isDefaultCash: false,
      interestRate: null,
      openedOn: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    }));
    const meter = meterDb(db);
    const specs = bulkInsertSpecs(accountsTable, accounts);
    expect(specs).toHaveLength(3);
    await runSpecs(meter.db, specs);
    await runSpecs(meter.db, bulkInsertSpecs(accountsTable, accounts.slice(0, 10), 'ignore'));
    await runSpecs(
      meter.db,
      bulkUpdateSpecs(
        accountsTable,
        accounts.slice(0, 450).map((a) => ({ key: { id: a.id }, changes: { balance: -1 } })),
      ),
    );
    expect(meter.used()).toBe(6);
    const stored = await selectAll(db, accountsTable, '', [], 'id');
    expect(stored).toHaveLength(900);
    const one = stored.find((a) => a.id === 'acc_1');
    expect(one).toMatchObject({
      institutionName: 'Bank "Quoted" ₹',
      balance: -1,
      includeInNetWorth: false,
    });
    expect(stored.find((a) => a.id === 'acc_899')).toMatchObject({
      balance: 89_900,
      includeInNetWorth: false,
    });
    expect(stored.find((a) => a.id === 'acc_3')?.includeInNetWorth).toBe(true);
  });
});

describe('a first sync with two years of history (3,120 transactions)', () => {
  it('finishes in several invocations, each under the Free plan query limit, without duplicates', async () => {
    expect(TOTAL).toBeGreaterThanOrEqual(3000);
    await addLinkedConnection('conn_2y');
    const fetch = sophtronFetch();
    const steps: { queries: number; inserted: number; more: boolean; status: number }[] = [];
    let cursorBeforeLast: string | null = 'unset';
    for (let i = 0; i < 10; i += 1) {
      const { status, report, queries } = await syncOnce('conn_2y', fetch);
      steps.push({
        status,
        queries,
        inserted: report.summary?.inserted ?? -1,
        more: report.more,
      });
      if (!report.more) break;
      const c = await selectOne(db, connectionsTable, 'id = ?', ['conn_2y']);
      expect(c?.status).toBe('syncing');
      cursorBeforeLast = c?.syncCursor ?? null;
    }

    // Several invocations, every one of them within the limit.
    expect(steps.length).toBeGreaterThanOrEqual(3);
    for (const s of steps) {
      expect(s.status).toBe(200);
      expect(s.queries).toBeLessThanOrEqual(D1_QUERIES_PER_INVOCATION);
    }
    expect(steps.at(-1)?.more).toBe(false);
    // The provider cursor did not move until the last part was written.
    expect(cursorBeforeLast).toBeNull();

    // Every row exactly once (plus the ATM cash deposits, which are new rows of their own).
    const rows = await selectAll(db, transactionsTable);
    const fromSophtron = rows.filter((t) => t.connectionId === 'conn_2y');
    expect(fromSophtron).toHaveLength(TOTAL);
    expect(new Set(fromSophtron.map((t) => t.externalId)).size).toBe(TOTAL);
    expect(steps.reduce((n, s) => n + s.inserted, 0)).toBe(TOTAL);

    // The connection is healthy with a cursor, and its accounts are attached.
    const conn = await selectOne(db, connectionsTable, 'id = ?', ['conn_2y']);
    expect(conn).toMatchObject({ status: 'healthy', lastError: null });
    expect(conn?.lastSuccessfulSyncAt).toBe(NOW.toISOString());
    expect(JSON.parse(conn?.syncCursor ?? '{}').since).toBe('2026-11-05');
    const accounts = await selectAll(db, accountsTable, 'connection_id = ?', ['conn_2y']);
    expect(accounts.map((a) => a.externalId).sort()).toEqual([CARD_ID, CHECKING_ID].sort());
    expect(accounts.find((a) => a.externalId === CARD_ID)?.balance).toBe(128_840);

    // After the last part: card payments are linked, ATM withdrawals have their cash side.
    const links = await selectAll(db, transferLinksTable);
    expect(links.filter((l) => l.kind === 'card_payment' && l.status === 'auto')).toHaveLength(24);
    expect(links.filter((l) => l.kind === 'atm_withdrawal')).toHaveLength(24);
    const cash = await selectAll(db, accountsTable, "type = 'cash'");
    expect(cash).toHaveLength(1);
    expect(cash[0]?.balance).toBe(24 * 20_000);

    // Newest rows went in first, so the first part already shows recent history.
    // One fetch per account per invocation, and no refresh jobs during a first sync.
    expect(fetch.calls.filter((p) => p.endsWith('/RefreshUserInstitutionAccount'))).toHaveLength(0);
  });

  it('a later sync after the first one adds nothing and stays small', async () => {
    await addLinkedConnection('conn_2y');
    const fetch = sophtronFetch();
    for (let i = 0; i < 10; i += 1) {
      if (!(await syncOnce('conn_2y', fetch)).report.more) break;
    }
    const again = await syncOnce('conn_2y', fetch);
    expect(again.report).toMatchObject({ outcome: 'ok', more: false });
    expect(again.report.summary?.inserted).toBe(0);
    expect(again.queries).toBeLessThanOrEqual(D1_QUERIES_PER_INVOCATION);
  });

  it('the five-minute cron finishes a first sync on its own when the app is closed', async () => {
    await addLinkedConnection('conn_2y');
    const fetch = sophtronFetch();
    const first = await syncOnce('conn_2y', fetch);
    expect(first.report.more).toBe(true);

    const worker = createWorker({ fetch });
    for (let i = 0; i < 10; i += 1) {
      const meter = meterDb(db);
      const ctx = createExecutionContext();
      await worker.scheduled(
        { cron: SYNC_CRON, scheduledTime: NOW.getTime() + i * 300_000, noRetry() {} },
        { ...env, DB: meter.db },
        ctx,
      );
      await waitOnExecutionContext(ctx);
      expect(meter.used()).toBeLessThanOrEqual(D1_QUERIES_PER_INVOCATION);
      const c = await selectOne(db, connectionsTable, 'id = ?', ['conn_2y']);
      if (c?.status === 'healthy') break;
    }
    const conn = await selectOne(db, connectionsTable, 'id = ?', ['conn_2y']);
    expect(conn?.status).toBe('healthy');
    const rows = await selectAll(db, transactionsTable, 'connection_id = ?', ['conn_2y']);
    expect(rows).toHaveLength(TOTAL);
  });
});

describe('daily syncs spread over the five-minute cron', () => {
  it('syncs every due connection across runs, never more than one invocation allows', async () => {
    // Four small logins (the existing Sophtron fixture shape), none synced today.
    const small = {
      accounts: [data.accounts[0]],
      txns: data.transactions[CHECKING_ID]!.slice(0, 20),
    };
    const fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      if (url.pathname.endsWith('/GetUserInstitutionAccounts'))
        return Response.json({ Accounts: small.accounts });
      return Response.json({ Transactions: small.txns });
    }) as typeof globalThis.fetch;
    for (const id of ['c1', 'c2', 'c3', 'c4']) {
      await addLinkedConnection(id, { lastSyncAt: '2026-11-04T06:00:00.000Z' });
    }
    await addLinkedConnection('c_today', { lastSyncAt: '2026-11-05T07:00:00.000Z' });
    const synced = new Set<string>();
    for (let run = 0; run < 6 && synced.size < 4; run += 1) {
      const meter = meterDb(db);
      const reports = await syncDueConnections(
        { ...env, DB: meter.db },
        { fetch, now: () => NOW, meter },
      );
      expect(meter.used()).toBeLessThanOrEqual(D1_QUERIES_PER_INVOCATION);
      for (const r of reports) synced.add(r.connectionId);
    }
    expect([...synced].sort()).toEqual(['c1', 'c2', 'c3', 'c4']);
  });
});
