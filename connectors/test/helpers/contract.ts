import { expect } from 'vitest';
import type {
  Connection,
  ConnectorAdapter,
  ConnectorContext,
  SyncResult,
} from '@manaclaude/shared';
import { ConnectorRepairNeededError } from '@manaclaude/shared';
import { runConnectionSync } from '../../src/sync';
import { MemoryStore } from './store';
import { makeConnection } from './fakeFetch';

/** Checks every adapter must pass, whatever the provider. */

export async function expectSyncShape(result: SyncResult): Promise<void> {
  const accountIds = new Set(result.accounts.map((a) => a.externalId));
  expect(new Set(result.accounts.map((a) => a.externalId)).size).toBe(result.accounts.length);
  for (const a of result.accounts) {
    expect(Number.isSafeInteger(a.balance), `${a.name} balance`).toBe(true);
    expect(a.currency).toMatch(/^[A-Z]{3,10}$/);
  }
  for (const t of result.transactions) {
    expect(Number.isSafeInteger(t.amount), `amount of ${t.externalId}`).toBe(true);
    expect(t.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(accountIds.has(t.accountExternalId), `account of ${t.externalId}`).toBe(true);
    expect(t.externalId).toBeTruthy();
  }
  for (const h of result.holdings) {
    expect(accountIds.has(h.accountExternalId), `account of holding ${h.symbol}`).toBe(true);
  }
  for (const a of result.activities) {
    expect(Number.isSafeInteger(a.amount)).toBe(true);
    expect(a.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }
}

/** Sync, apply, sync again with the same responses: the second pass must add and change nothing. */
export async function expectRepeatSyncIsQuiet(
  adapter: ConnectorAdapter,
  makeContext: () => ConnectorContext,
  connection: Connection = makeConnection(adapter.id),
): Promise<{ store: MemoryStore; first: SyncResult }> {
  const store = new MemoryStore();
  const first = await adapter.sync(makeContext(), connection);
  store.apply(connection, first);
  const afterFirst = JSON.stringify(store.transactions);
  const second = await adapter.sync(makeContext(), { ...connection, syncCursor: first.nextCursor });
  const { txn, acc, inv } = store.apply(connection, second);
  expect(txn.inserts, 'second sync inserts').toEqual([]);
  expect(txn.removals, 'second sync removals').toEqual([]);
  expect(acc.inserts).toEqual([]);
  expect(inv.holdingInserts).toEqual([]);
  expect(inv.lotInserts).toEqual([]);
  expect(inv.activityInserts).toEqual([]);
  expect(JSON.stringify(store.transactions)).toBe(afterFirst);
  return { store, first };
}

/** An expired token must surface as ConnectorRepairNeededError and as status needs_repair, not a crash. */
export async function expectRepairOnExpiredToken(
  adapter: ConnectorAdapter,
  makeContext: () => ConnectorContext,
  connection: Connection = makeConnection(adapter.id),
): Promise<void> {
  await expect(adapter.sync(makeContext(), connection)).rejects.toBeInstanceOf(
    ConnectorRepairNeededError,
  );
  const outcome = await runConnectionSync(adapter, makeContext(), connection);
  expect(outcome.kind).toBe('needs_repair');
  expect(outcome.connection.status).toBe('needs_repair');
  expect(outcome.connection.lastError).toBeTruthy();
  expect((outcome.connection.lastError ?? '').length).toBeLessThan(200);
}
