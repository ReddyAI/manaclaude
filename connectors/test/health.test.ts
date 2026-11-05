import { describe, expect, it } from 'vitest';
import { ConnectorRepairNeededError } from '@manaclaude/shared';
import {
  afterSyncFailure,
  afterSyncSuccess,
  completeRepair,
  describeHealth,
  planRepair,
} from '../src/health';
import { ConnectorRateLimitedError, ProviderHttpError } from '../src/errors';
import { getConnector } from '../src/registry';
import { runConnectionSync } from '../src/sync';
import { fakeFetch, makeConnection, makeCtx, NOW } from './helpers/fakeFetch';
import { emptyResult } from '../src/kit';

const NOW_ISO = NOW.toISOString();

describe('connection health', () => {
  it('describes each status', () => {
    const base = {
      lastSyncAt: null,
      lastSuccessfulSyncAt: '2026-11-05T10:00:00.000Z',
      lastError: null,
    };
    expect(describeHealth({ ...base, status: 'healthy' }, NOW)).toMatchObject({
      label: 'Healthy',
      tone: 'good',
      stale: false,
      detail: 'Synced 2 h ago',
    });
    expect(
      describeHealth(
        { ...base, status: 'healthy', lastSuccessfulSyncAt: '2026-11-01T10:00:00.000Z' },
        NOW,
      ),
    ).toMatchObject({ label: 'Stale', tone: 'warn', stale: true });
    expect(
      describeHealth({ ...base, status: 'healthy', lastSuccessfulSyncAt: null }, NOW),
    ).toMatchObject({ label: 'Stale', detail: 'Never synced' });
    expect(
      describeHealth({ ...base, status: 'needs_repair', lastError: 'Teller: login expired.' }, NOW),
    ).toMatchObject({
      label: 'Repair needed',
      tone: 'bad',
      needsRepair: true,
      detail: 'Teller: login expired.',
    });
    expect(
      describeHealth(
        { ...base, status: 'error', lastError: 'Plaid request failed (HTTP 500)' },
        NOW,
      ),
    ).toMatchObject({ label: 'Sync error', tone: 'warn' });
    expect(describeHealth({ ...base, status: 'syncing' }, NOW).label).toBe('Syncing');
    expect(describeHealth({ ...base, status: 'disconnected' }, NOW).label).toBe('Disconnected');
  });

  it('a good sync clears the error and moves the cursor', () => {
    const c = makeConnection('teller', {
      status: 'error',
      lastError: 'x',
      syncCursor: '{"since":"2026-10-01"}',
    });
    const ok = afterSyncSuccess(c, NOW_ISO, '{"since":"2026-11-05"}', ['acc_1']);
    expect(ok).toMatchObject({
      status: 'healthy',
      lastError: null,
      lastSyncAt: NOW_ISO,
      lastSuccessfulSyncAt: NOW_ISO,
      syncCursor: '{"since":"2026-11-05"}',
      accountIds: ['acc_1'],
    });
    expect(afterSyncSuccess(c, NOW_ISO, null).syncCursor).toBe('{"since":"2026-10-01"}');
  });

  it('a repair error sets needs_repair and keeps the cursor and the last good sync', () => {
    const c = makeConnection('teller', {
      status: 'healthy',
      lastSuccessfulSyncAt: '2026-11-04T00:00:00.000Z',
      syncCursor: 'cur',
    });
    const bad = afterSyncFailure(
      c,
      new ConnectorRepairNeededError('Teller: login expired.'),
      NOW_ISO,
    );
    expect(bad).toMatchObject({
      status: 'needs_repair',
      lastError: 'Teller: login expired.',
      syncCursor: 'cur',
      lastSuccessfulSyncAt: '2026-11-04T00:00:00.000Z',
    });
  });

  it('a rate limit does not turn a healthy login red; other failures set error; needs_repair sticks', () => {
    const healthy = makeConnection('x', { status: 'healthy' });
    expect(
      afterSyncFailure(healthy, new ConnectorRateLimitedError('X', 30), NOW_ISO),
    ).toMatchObject({ status: 'healthy', lastError: 'X rate limit reached; try again later' });
    expect(
      afterSyncFailure(healthy, new ProviderHttpError('X', 500, 'secret body'), NOW_ISO),
    ).toMatchObject({ status: 'error', lastError: 'X request failed (HTTP 500)' });
    expect(
      afterSyncFailure(makeConnection('x', { status: 'needs_repair' }), new Error('boom'), NOW_ISO)
        .status,
    ).toBe('needs_repair');
  });
});

describe('repair flow', () => {
  it('plans a repair that keeps the accounts and cursor and never spends a slot', () => {
    const conn = makeConnection('teller', {
      status: 'needs_repair',
      accountIds: ['a', 'b'],
      syncCursor: 'cur',
    });
    const plan = planRepair(conn, getConnector('teller')!);
    expect(plan).toMatchObject({
      connectionId: conn.id,
      connectorId: 'teller',
      method: 'relink_widget',
      usesNewSlot: false,
      keeps: { accountIds: ['a', 'b'], syncCursor: 'cur' },
    });
  });

  it('picks the repair method from how the connector logs in', () => {
    const method = (id: string) => planRepair(makeConnection(id), getConnector(id)!).method;
    expect(method('plaid')).toBe('relink_widget');
    expect(method('sophtron')).toBe('reenter_credentials');
    expect(method('wise')).toBe('new_token');
    expect(method('coinbase')).toBe('new_token');
    expect(method('enable_banking')).toBe('reauthorize');
    expect(method('onchain')).toBe('none');
  });

  it('completing a repair clears the error and queues a sync, but is not healthy yet', () => {
    const fixed = completeRepair(
      makeConnection('teller', { status: 'needs_repair', lastError: 'x', accountIds: ['a'] }),
      NOW_ISO,
    );
    expect(fixed).toMatchObject({ status: 'syncing', lastError: null, accountIds: ['a'] });
  });
});

describe('running a sync safely', () => {
  const adapter = { id: 'demo', sync: async () => ({ ...emptyResult(), nextCursor: 'next' }) };
  const failing = (error: Error) => ({ id: 'demo', sync: async () => Promise.reject(error) });
  const ctx = makeCtx({}, fakeFetch({}));

  it('succeeds into healthy with the new cursor', async () => {
    const out = await runConnectionSync(adapter, ctx, makeConnection('demo'));
    expect(out).toMatchObject({ kind: 'ok', error: null });
    expect(out.connection).toMatchObject({ status: 'healthy', syncCursor: 'next' });
  });

  it('never throws: repair errors become needs_repair, others become error', async () => {
    const repair = await runConnectionSync(
      failing(new ConnectorRepairNeededError('Demo: login expired.')),
      ctx,
      makeConnection('demo'),
    );
    expect(repair).toMatchObject({ kind: 'needs_repair', error: 'Demo: login expired.' });
    const other = await runConnectionSync(failing(new Error('boom')), ctx, makeConnection('demo'));
    expect(other).toMatchObject({ kind: 'error' });
    expect(other.connection.status).toBe('error');
  });

  it('does not call the provider for a connection that needs repair, unless forced', async () => {
    let calls = 0;
    const counting = {
      id: 'demo',
      sync: async () => {
        calls++;
        return emptyResult();
      },
    };
    const broken = makeConnection('demo', {
      status: 'needs_repair',
      lastError: 'Demo: login expired.',
    });
    expect((await runConnectionSync(counting, ctx, broken)).kind).toBe('skipped');
    expect(calls).toBe(0);
    const forced = await runConnectionSync(counting, ctx, broken, { force: true });
    expect(forced.kind).toBe('ok');
    expect(forced.connection.status).toBe('healthy');
    expect(calls).toBe(1);
  });
});
