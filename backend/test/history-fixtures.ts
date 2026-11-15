import type { Account, Connection, ProviderTransaction, SyncResult } from '@manaclaude/shared';
import { previewHistoryPolicy, saveHistoryPolicy } from '../src/history/service';
import type { HistoryPolicy } from '../src/history/model';
import { insertStatement } from '../src/db/table';
import { connectionsTable } from '../src/db/tables';
import { addAccount, db, file } from './helpers';
export const NOW = '2026-11-05T12:00:00.000Z';
export const policy: HistoryPolicy = { defaultCutoff: '2024-04-15', accounts: [] };
export const historyFile = (rows: string[]) =>
  file(
    ['date,account,category,amount,currency,converted amount,currency,description', ...rows].join(
      '\n',
    ),
    'invented-history.csv',
  );
export const bank = (name = 'Orchard') =>
  addAccount({
    type: 'checking',
    name,
    connectionId: 'conn_history',
    externalId: `provider-${name}`,
  });
export async function activate(p: HistoryPolicy = policy, database = db) {
  const preview = await previewHistoryPolicy(database, p);
  return saveHistoryPolicy(
    database,
    { policy: p, expectedVersion: preview.expectedVersion, previewToken: preview.previewToken },
    NOW,
  );
}
export async function connection(): Promise<Connection> {
  const c: Connection = {
    id: 'conn_history',
    connectorId: 'simplefin',
    institutionName: 'Invented Bank',
    status: 'syncing',
    lastSyncAt: null,
    lastSuccessfulSyncAt: null,
    lastError: null,
    syncCursor: null,
    accountIds: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
  await insertStatement(db, connectionsTable, c).run();
  return c;
}
export function provider(
  a: Account,
  date: string,
  amount = -500,
  externalId = `p-${date}`,
): ProviderTransaction {
  return {
    externalId,
    accountExternalId: a.externalId!,
    date,
    amount,
    currency: a.currency,
    originalAmount: null,
    originalCurrency: null,
    rawName: 'Invented purchase',
    merchantName: null,
    pending: false,
    pendingExternalId: null,
    categoryHint: null,
  };
}
export function result(accounts: Account[], transactions: ProviderTransaction[]): SyncResult {
  return {
    accounts: accounts.map((a) => ({
      externalId: a.externalId!,
      name: a.name,
      type: a.type,
      subtype: null,
      currency: a.currency,
      balance: 98765,
      availableBalance: 87654,
      creditLimit: null,
      mask: null,
      institutionName: null,
    })),
    transactions,
    activities: [],
    holdings: [],
    removedTransactionExternalIds: [],
    nextCursor: 'next',
  };
}
export function beforeBatch(action: () => Promise<unknown>, batchNumber = 1): D1Database {
  let calls = 0;
  return new Proxy(db, {
    get(target, key) {
      if (key === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (++calls === batchNumber) await action();
          return target.batch(statements);
        };
      const value: unknown = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
