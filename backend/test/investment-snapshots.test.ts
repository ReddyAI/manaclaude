import { beforeEach, describe, expect, it } from 'vitest';
import {
  resultsFromActivities,
  type Account,
  type SyncResult,
  type ProviderActivity,
} from '@manaclaude/shared';
import { applySyncResult } from '../src/sync/apply';
import { investmentRevision } from '../src/sync/investments';
import { syncConnection } from '../src/sync/run';
import { saveCredentials } from '../src/sync/credentials';
import { selectAll, insertStatement } from '../src/db/table';
import {
  accountsTable,
  activitiesTable,
  connectionsTable,
  holdingsTable,
  taxLotsTable,
} from '../src/db/tables';
import { meterDb, QueryBudget } from '../src/db/meter';
import { addAccount, db, freshDb, testEnv } from './helpers';
import { NOW, beforeBatch, connection, result } from './history-fixtures';
beforeEach(freshDb);

async function setup() {
  const c = await connection();
  const a = await addAccount({ type: 'brokerage', connectionId: c.id, externalId: 'orchard' });
  const initial = portfolio([a]);
  initial.holdings.push({
    accountExternalId: 'orchard',
    symbol: 'ORCH',
    name: 'Orchard',
    securityType: 'equity',
    exchange: 'NASDAQ',
    quantity: '2',
    price: '15',
    currency: 'USD',
    costBasis: 2000,
    lots: null,
  });
  await applySyncResult(db, c, initial, NOW);
  return { c, a, initial };
}
function portfolio(accounts: Account[]): SyncResult {
  return {
    ...result(accounts, []),
    holdingsSnapshots: accounts.map((a) => ({
      accountExternalId: a.externalId!,
      status: 'complete',
    })),
  };
}
const archive = async () =>
  (
    await db.prepare('SELECT * FROM investment_archive ORDER BY id').all<{
      record_type: string;
      record_json: string;
    }>()
  ).results;
const act = (
  id: string,
  type: 'buy' | 'sell',
  quantity: string,
  amount: number,
): ProviderActivity => ({
  externalId: id,
  accountExternalId: 'orchard',
  symbol: 'ORCH',
  type,
  quantity,
  amount,
  price: '10',
  currency: 'USD',
  fees: 0,
  splitRatio: null,
  date: type === 'buy' ? '2025-01-01' : '2026-10-30',
});

describe('authoritative holdings snapshots', () => {
  it('removes the last holding without activities and archives its exact basis; replay adds no archive', async () => {
    const { c, a } = await setup();
    const holdings = await selectAll(db, holdingsTable),
      lots = await selectAll(db, taxLotsTable);
    await applySyncResult(db, c, portfolio([a]), NOW);
    expect(await selectAll(db, holdingsTable)).toEqual([]);
    expect(await selectAll(db, taxLotsTable)).toEqual([]);
    const records = await archive();
    expect(
      records.filter((r) => r.record_type === 'holding').map((r) => JSON.parse(r.record_json)),
    ).toEqual(holdings);
    expect(
      records.filter((r) => r.record_type === 'lot').map((r) => JSON.parse(r.record_json)),
    ).toEqual(lots);
    expect(await selectAll(db, activitiesTable)).toEqual([]); // no invented sale
    await applySyncResult(db, c, portfolio([a]), NOW);
    expect(await archive()).toEqual(records);
  });
  it.each(['partial', 'unavailable', 'failed', 'unsupported', 'unknown', undefined] as const)(
    'preserves omitted positions for %s evidence while updating balances and activity',
    async (status) => {
      const { c, a } = await setup();
      const r = result([a], []);
      r.accounts[0]!.balance = 876;
      if (status) r.holdingsSnapshots = [{ accountExternalId: 'orchard', status }];
      r.activities = [{ ...act('dividend', 'buy', '0', 30), type: 'dividend', quantity: null }];
      const before = await selectAll(db, holdingsTable);
      await applySyncResult(db, c, r, NOW);
      expect(await selectAll(db, holdingsTable)).toEqual(before);
      expect((await selectAll(db, accountsTable))[0]!.balance).toBe(876);
      expect(await selectAll(db, activitiesTable)).toHaveLength(1);
      expect(await archive()).toEqual([]);
    },
  );
  it('limits removals to the covered account and preserves manual positions, including the same symbol', async () => {
    const { c, a, initial } = await setup();
    const b = await addAccount({ type: 'brokerage', connectionId: c.id, externalId: 'meadow' });
    const other = await addAccount({
      type: 'brokerage',
      connectionId: 'unrelated',
      externalId: 'other',
    });
    const h = (await selectAll(db, holdingsTable))[0]!;
    for (const [id, accountId, source] of [
      ['hold_manual', a.id, 'manual'],
      ['hold_b', b.id, 'connector'],
      ['hold_other', other.id, 'connector'],
    ] as const)
      await insertStatement(db, holdingsTable, { ...h, id, accountId, source }).run();
    const r = portfolio([a, b]);
    r.holdings = [{ ...initial.holdings[0]!, accountExternalId: 'meadow', quantity: '3' }];
    // A declaration about an account outside this connection cannot take ownership.
    r.holdingsSnapshots!.push({ accountExternalId: 'other', status: 'complete' });
    await applySyncResult(db, c, r, NOW);
    const after = await selectAll(db, holdingsTable);
    expect(after.map((x) => x.id).sort()).toEqual(['hold_b', 'hold_manual', 'hold_other']);
    expect(after.find((x) => x.id === 'hold_manual')).toEqual({
      ...h,
      id: 'hold_manual',
      source: 'manual',
    });
    expect(after.find((x) => x.id === 'hold_b')!.quantity).toBe('3');
  });
  it('preserves historical activity and realized gains after full sale and later empty snapshots', async () => {
    const { c, a, initial } = await setup();
    initial.activities = [act('buy', 'buy', '4', -4000), act('sell-part', 'sell', '2', 3000)];
    await applySyncResult(db, c, initial, NOW);
    const prior = resultsFromActivities(await selectAll(db, activitiesTable));
    expect(prior.realized[0]!.gain).toBe(1000);
    const sold = portfolio([a]);
    sold.activities = [act('sell-last', 'sell', '2', 3200)];
    await applySyncResult(db, c, sold, NOW);
    const activities = await selectAll(db, activitiesTable);
    expect(resultsFromActivities(activities).realized.reduce((sum, r) => sum + r.gain, 0)).toBe(
      2200,
    );
    await applySyncResult(db, c, portfolio([a]), NOW);
    expect(await selectAll(db, activitiesTable)).toEqual(activities);
    expect(await selectAll(db, holdingsTable)).toEqual([]);
  });
  it('waits for the final activity continuation before removing inventory and advancing the cursor', async () => {
    const { c, a } = await setup();
    const sold = portfolio([a]);
    sold.nextCursor = 'finished';
    sold.activities = [act('buy', 'buy', '2', -2000), act('sold', 'sell', '2', 3000)];
    const first = await applySyncResult(db, c, sold, NOW, { maxRows: 1 });
    expect(first.more).toBe(true);
    expect(await selectAll(db, holdingsTable)).toHaveLength(1);
    expect(await archive()).toEqual([]);
    expect((await selectAll(db, connectionsTable))[0]!.syncCursor).not.toBe('finished');
    const second = await applySyncResult(db, c, sold, NOW, { maxRows: 1 });
    expect(second.more).toBe(false);
    expect(await selectAll(db, holdingsTable)).toEqual([]);
    expect((await selectAll(db, connectionsTable))[0]!.syncCursor).toBe('finished');
    expect(await selectAll(db, activitiesTable)).toHaveLength(2);
    expect(resultsFromActivities(await selectAll(db, activitiesTable)).realized[0]!.gain).toBe(
      1000,
    );
  });
  it('rolls back removal, archive, activity, cursor and revision together; balances stay independent', async () => {
    const { c, a } = await setup();
    const revision = await investmentRevision(db);
    const before = await selectAll(db, holdingsTable);
    const r = portfolio([a]);
    r.activities = [act('sale', 'sell', '2', 3000)];
    r.accounts[0]!.balance = 555;
    let batches = 0;
    const failing = new Proxy(db, {
      get(target, key) {
        if (key === 'batch')
          return (statements: D1PreparedStatement[]) =>
            target.batch(
              ++batches === 2
                ? [
                    ...statements,
                    target.prepare("INSERT INTO investment_write_guard VALUES ('fail', 0)"),
                  ]
                : statements,
            );
        const value: unknown = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(applySyncResult(failing, c, r, NOW)).rejects.toThrow();
    expect(await selectAll(db, holdingsTable)).toEqual(before);
    expect(await archive()).toEqual([]);
    expect(await selectAll(db, activitiesTable)).toEqual([]);
    expect(await investmentRevision(db)).toBe(revision);
    expect((await selectAll(db, accountsTable))[0]!.balance).toBe(555);
    await applySyncResult(db, c, r, NOW);
    expect(await selectAll(db, holdingsTable)).toEqual([]);
  });
  it.each(['holdings', 'tax_lots', 'investment_activities'] as const)(
    'fences concurrent writes to %s, even at the same timestamp',
    async (table) => {
      const { c, a } = await setup();
      const raced = beforeBatch(async () => {
        if (table === 'investment_activities') {
          const r = result([a], []);
          r.activities = [act('other-buy', 'buy', '2', -2000)];
          await applySyncResult(db, c, r, NOW);
        } else await db.prepare(`UPDATE ${table} SET cost_basis = cost_basis + 1`).run();
      }, 2);
      await expect(applySyncResult(raced, c, portfolio([a]), NOW)).rejects.toThrow(
        /Investments changed/,
      );
      expect(await selectAll(db, holdingsTable)).toHaveLength(1);
      expect(await archive()).toEqual([]);
    },
  );
  it('fences account reassignment with history policy inactive', async () => {
    const { c, a } = await setup();
    const raced = beforeBatch(
      () => db.prepare("UPDATE accounts SET connection_id = 'other' WHERE id = ?").bind(a.id).run(),
      2,
    );
    await expect(applySyncResult(raced, c, portfolio([a]), NOW)).rejects.toThrow(/History/);
    expect(await selectAll(db, holdingsTable)).toHaveLength(1);
  });
  it('rejects an older response after a newer empty commit, even when no financial row changed', async () => {
    const { c, a } = await setup();
    await applySyncResult(db, c, portfolio([a]), NOW);
    const revision = await investmentRevision(db);
    await applySyncResult(db, c, portfolio([a]), NOW);
    await expect(
      applySyncResult(db, c, portfolio([a]), NOW, { investmentRevision: revision }),
    ).rejects.toThrow(/Investments changed/);
  });
  it('fits the final atomic inventory without starving it for optional post-processing', async () => {
    const { c, a } = await setup();
    const meter = meterDb(db);
    const summary = await applySyncResult(meter.db, c, portfolio([a]), NOW, {
      budget: new QueryBudget(meter, 25),
    });
    expect(summary.more).toBe(false);
    expect(meter.used()).toBeLessThanOrEqual(25);
    expect(await selectAll(db, holdingsTable)).toEqual([]);
  });
});

it('overlapping mocked provider calls cannot let a stale empty snapshot remove newer positions or health', async () => {
  const c = await connection();
  await db
    .prepare("UPDATE connections SET connector_id = 'trading212' WHERE id = ?")
    .bind(c.id)
    .run();
  const env = { ...testEnv, CREDENTIALS_SECRET: 'invented-investment-secret' };
  await saveCredentials(env, c.id, { T212_API_KEY: 'invented', T212_API_SECRET: 'invented' });
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const transport = (stale: boolean) =>
    (async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      let json: unknown = { items: [], nextPagePath: null };
      if (path.endsWith('/summary')) json = { id: 'orchard', currency: 'USD', totalValue: 30 };
      if (path.endsWith('/positions')) {
        if (stale) {
          entered();
          await waiting;
          json = [];
        } else
          json = [
            {
              instrument: { ticker: 'ORCH_US_EQ', currency: 'USD' },
              quantity: 2,
              currentPrice: 15,
              averagePricePaid: 10,
            },
          ];
      }
      return new Response(JSON.stringify(json), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
  const older = syncConnection(env, c.id, { fetch: transport(true), now: () => new Date(NOW) });
  await started;
  const newer = await syncConnection(env, c.id, {
    fetch: transport(false),
    now: () => new Date(NOW),
  });
  release();
  const obsolete = await older;
  expect(newer.outcome).toBe('ok');
  expect(obsolete.outcome).toBe('error');
  expect(await selectAll(db, holdingsTable)).toHaveLength(1);
  expect((await selectAll(db, connectionsTable))[0]!.status).toBe('healthy');
  expect(await archive()).toEqual([]);
});

it('a lost successful batch response replays without duplicating archives or sales', async () => {
  const { c, a } = await setup();
  let batches = 0;
  const lost = new Proxy(db, {
    get(target, key) {
      if (key === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements);
          if (++batches === 2) throw new Error('Invented lost response');
          return results;
        };
      const value: unknown = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await expect(applySyncResult(lost, c, portfolio([a]), NOW)).rejects.toThrow(/lost response/);
  const records = await archive();
  expect(records).toHaveLength(2);
  expect(await selectAll(db, holdingsTable)).toEqual([]);
  await applySyncResult(db, c, portfolio([a]), NOW);
  expect(await archive()).toEqual(records);
  expect(await selectAll(db, activitiesTable)).toEqual([]);
});
it('archives superseded broker basis before updates and later removal', async () => {
  const { c, a, initial } = await setup();
  const firstLot = (await selectAll(db, taxLotsTable))[0]!;
  initial.holdings[0]!.costBasis = 2200;
  await applySyncResult(db, c, initial, NOW);
  const records = await archive();
  expect(
    records.some(
      (r) => r.record_type === 'lot' && JSON.parse(r.record_json).costBasis === firstLot.costBasis,
    ),
  ).toBe(true);
  await applySyncResult(db, c, portfolio([a]), NOW);
  expect(
    (await archive())
      .filter((r) => r.record_type === 'lot')
      .map((r) => JSON.parse(r.record_json).costBasis)
      .sort(),
  ).toEqual([2000, 2200]);
});
