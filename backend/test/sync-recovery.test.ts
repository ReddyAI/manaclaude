import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import type { Connection } from '@manaclaude/shared';
import { httpRuntime } from '../../connectors/src/http';
import sfAccounts from '../../connectors/fixtures/simplefin/accounts.json';
import { insertStatement, selectAll, selectOne } from '../src/db/table';
import { connectionsTable, transactionsTable } from '../src/db/tables';
import { D1_QUERIES_PER_INVOCATION, meterDb } from '../src/db/meter';
import { markRepaired } from '../src/link/service';
import { saveCredentials } from '../src/sync/credentials';
import { fetchForConnector, syncConnection, syncDueConnections } from '../src/sync/run';
import { retrySchedule } from '../src/sync/retries';
import { createWorker, SYNC_CRON } from '../src/worker';
import { freshDb, testEnv } from './helpers';
import { client } from './worker';

const NOW = new Date('2026-11-05T12:00:00.000Z');
const env = { ...testEnv, CREDENTIALS_SECRET: 'invented-sync-recovery-key-0123456789' };
const db = env.DB;

async function addConnection(id: string, overrides: Partial<Connection> = {}) {
  const connection: Connection = {
    id,
    connectorId: 'simplefin',
    institutionName: 'Invented bank',
    status: 'syncing',
    lastSyncAt: null,
    lastSuccessfulSyncAt: null,
    lastError: null,
    syncCursor: null,
    accountIds: [],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
  await insertStatement(db, connectionsTable, connection).run();
  await saveCredentials(env, id, {
    SIMPLEFIN_ACCESS_URL: 'https://invented:invented@bridge.example.invalid/simplefin',
  });
  return connection;
}

function provider(status = 200, headers?: HeadersInit) {
  return vi.fn<typeof fetch>(async () =>
    Response.json(status === 200 ? sfAccounts : {}, { status, headers }),
  );
}

async function cron(now: Date, fetch: typeof globalThis.fetch) {
  const meter = meterDb(db);
  const ctx = createExecutionContext();
  await createWorker({ fetch }).scheduled(
    { cron: SYNC_CRON, scheduledTime: now.getTime(), noRetry() {} },
    { ...env, DB: meter.db },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  expect(meter.used()).toBeLessThanOrEqual(D1_QUERIES_PER_INVOCATION);
}

beforeEach(async () => {
  await freshDb();
  vi.spyOn(httpRuntime, 'sleep').mockResolvedValue();
});
afterEach(() => vi.restoreAllMocks());

describe('Plaid disabled across sync paths', () => {
  it.each([false, true])(
    'blocks a manual sync before credentials are read (force=%s)',
    async (force) => {
      expect(env.PLAID_LINK_ENABLED).not.toBe('true');
      const before = await addConnection('plaid_saved', {
        connectorId: 'plaid',
        status: 'needs_repair',
      });
      const fetch = provider();
      const result = await client(
        { fetch, now: () => NOW },
        { ...env, CREDENTIALS_SECRET: undefined },
      ).api('POST', `/v1/connections/plaid_saved/sync${force ? '?force=true' : ''}`);
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        outcome: 'skipped',
        skippedBecause: 'disabled',
        error: 'Plaid is disabled. No data was requested.',
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(await selectOne(db, connectionsTable, 'id = ?', [before.id])).toEqual(before);
      expect(await retrySchedule(db)).toEqual(new Map());
    },
  );

  it('cron ignores a saved Plaid login while syncing an enabled connector', async () => {
    const before = await addConnection('plaid_saved', { connectorId: 'plaid' });
    await addConnection('simplefin_saved');
    const fetch = provider();
    await cron(NOW, fetch);
    expect(fetch).toHaveBeenCalled();
    for (const [url] of fetch.mock.calls) expect(String(url)).toContain('bridge.example.invalid');
    expect(await selectOne(db, connectionsTable, 'id = ?', [before.id])).toEqual(before);
    expect((await selectOne(db, connectionsTable, 'id = ?', ['simplefin_saved']))?.status).toBe(
      'healthy',
    );
  });

  it('the outbound transport also denies disabled Plaid before an injected fetch', async () => {
    const fetch = provider();
    await expect(
      fetchForConnector(env, 'plaid', fetch)('https://provider.example.invalid/probe'),
    ).rejects.toThrow('Plaid is disabled');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('automatic sync recovery', () => {
  it('retries a failed first sync in five minutes and then returns to daily freshness', async () => {
    await addConnection('first');
    const failure = provider(503);
    await cron(NOW, failure);
    expect((await selectOne(db, connectionsTable, 'id = ?', ['first']))?.status).toBe('error');
    expect((await retrySchedule(db)).get('first')).toBe(NOW.getTime() + 300_000);
    const success = provider();
    await cron(new Date(NOW.getTime() + 299_999), success);
    expect(success).not.toHaveBeenCalled();
    await cron(new Date(NOW.getTime() + 300_000), success);
    expect(success).toHaveBeenCalled();
    expect(await selectOne(db, connectionsTable, 'id = ?', ['first'])).toMatchObject({
      status: 'healthy',
      lastError: null,
      lastSuccessfulSyncAt: '2026-11-05T12:05:00.000Z',
    });
    expect(await retrySchedule(db)).toEqual(new Map());
    success.mockClear();
    await cron(new Date(NOW.getTime() + 600_000), success);
    expect(success).not.toHaveBeenCalled();
    await cron(new Date('2026-11-06T06:30:00.000Z'), success);
    expect(success).toHaveBeenCalled();
  });

  it('persists increasing delays, including across midnight, and caps the delay at one day', async () => {
    await addConnection('outage');
    let time = new Date('2026-11-05T23:58:00.000Z').getTime();
    for (const minutes of [5, 15, 60, 360, 1440, 1440]) {
      const failure = provider(503);
      await cron(new Date(time), failure);
      expect(failure).toHaveBeenCalled();
      const next = time + minutes * 60_000;
      expect((await retrySchedule(db)).get('outage')).toBe(next);
      const tooSoon = provider();
      await cron(new Date(next - 1), tooSoon);
      expect(tooSoon).not.toHaveBeenCalled();
      time = next;
    }
    expect(
      await db
        .prepare('SELECT attempts FROM sync_retries WHERE connection_id = ?')
        .bind('outage')
        .first(),
    ).toEqual({ attempts: 5 });
  });

  it('also retries a healthy connection after a rate limit without using its last attempt as success', async () => {
    await addConnection('limited', {
      status: 'healthy',
      lastSuccessfulSyncAt: '2026-11-04T12:00:00.000Z',
    });
    const failure = provider(429);
    await cron(NOW, failure);
    expect(await selectOne(db, connectionsTable, 'id = ?', ['limited'])).toMatchObject({
      status: 'healthy',
      lastSuccessfulSyncAt: '2026-11-04T12:00:00.000Z',
    });
    const success = provider();
    await cron(new Date(NOW.getTime() + 300_000), success);
    expect(success).toHaveBeenCalled();
    expect(await retrySchedule(db)).toEqual(new Map());
  });

  it('keeps a partial sync cursor and existing transactions through a failed continuation', async () => {
    await addConnection('partial');
    const first = await syncConnection(env, 'partial', {
      fetch: provider(),
      now: () => NOW,
      maxRows: 1,
    });
    expect(first.more).toBe(true);
    const before = await selectAll(db, transactionsTable);
    const failedAt = new Date(NOW.getTime() + 60_000);
    expect(
      (await syncConnection(env, 'partial', { fetch: provider(503), now: () => failedAt })).outcome,
    ).toBe('error');
    expect(await selectAll(db, transactionsTable)).toEqual(before);
    expect((await selectOne(db, connectionsTable, 'id = ?', ['partial']))?.syncCursor).toBeNull();
    await cron(new Date(failedAt.getTime() + 300_000), provider());
    const rows = await selectAll(db, transactionsTable);
    expect(rows.length).toBeGreaterThan(before.length);
    expect(new Set(rows.map((t) => `${t.accountId}:${t.externalId}`)).size).toBe(rows.length);
    expect((await selectOne(db, connectionsTable, 'id = ?', ['partial']))?.status).toBe('healthy');
  });

  it('honors a provider Retry-After longer than the normal backoff', async () => {
    await addConnection('limited_longer');
    await cron(NOW, provider(429, { 'retry-after': '3600' }));
    expect((await retrySchedule(db)).get('limited_longer')).toBe(NOW.getTime() + 3_600_000);
    const success = provider();
    await cron(new Date(NOW.getTime() + 300_000), success);
    expect(success).not.toHaveBeenCalled();
    await cron(new Date(NOW.getTime() + 3_600_000), success);
    expect(success).toHaveBeenCalled();
  });

  it('stops automatic retries when the login needs Repair and resumes after repair', async () => {
    await addConnection('repair');
    await cron(NOW, provider(503));
    const next = new Date(NOW.getTime() + 300_000);
    await cron(next, provider(403));
    expect((await selectOne(db, connectionsTable, 'id = ?', ['repair']))?.status).toBe(
      'needs_repair',
    );
    expect(await retrySchedule(db)).toEqual(new Map());
    const success = provider();
    await cron(new Date(next.getTime() + 86_400_000), success);
    expect(success).not.toHaveBeenCalled();
    await markRepaired(env, 'repair', 'simplefin', next);
    await cron(next, success);
    expect(success).toHaveBeenCalled();
  });

  it('a manual retry and an explicit Repair can proceed during backoff and reset it after progress', async () => {
    await addConnection('manual');
    await cron(NOW, provider(503));
    const success = provider();
    expect((await syncConnection(env, 'manual', { fetch: success, now: () => NOW })).outcome).toBe(
      'ok',
    );
    expect(await retrySchedule(db)).toEqual(new Map());
    await syncConnection(env, 'manual', { fetch: provider(503), now: () => NOW });
    expect((await retrySchedule(db)).get('manual')).toBe(NOW.getTime() + 300_000);
    await markRepaired(env, 'manual', 'simplefin', NOW);
    await cron(NOW, success);
    expect(await retrySchedule(db)).toEqual(new Map());
  });

  it('recovers errors from before the retry migration and leaves disconnected connections alone', async () => {
    await addConnection('legacy', {
      status: 'error',
      lastSyncAt: '2026-11-05T11:55:00.000Z',
      lastError: 'Earlier outage',
    });
    await addConnection('off', { status: 'disconnected', lastError: 'Earlier outage' });
    const fetch = provider();
    const reports = await syncDueConnections(env, { fetch, now: () => NOW });
    expect(reports.map((r) => r.connectionId)).toEqual(['legacy']);
    expect((await selectOne(db, connectionsTable, 'id = ?', ['off']))?.status).toBe('disconnected');
  });
});
