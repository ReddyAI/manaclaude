import type {
  Account,
  Connection,
  Holding,
  InvestmentActivity,
  Security,
  SyncResult,
  TaxLot,
  Transaction,
} from '@manaclaude/shared';
import {
  planAccountSync,
  planInvestmentSync,
  planTransactionSync,
  type IdFactory,
  type TransactionSyncOptions,
} from '../../src/sync';

/** A tiny in-memory stand-in for what session B keeps in D1, to run sync plans end to end. */
export class MemoryStore {
  accounts: Account[] = [];
  transactions: Transaction[] = [];
  securities: Security[] = [];
  holdings: Holding[] = [];
  taxLots: TaxLot[] = [];
  activities: InvestmentActivity[] = [];
  private counter = 0;
  readonly newId: IdFactory = (kind) => `${kind}_${++this.counter}`;

  apply(
    connection: Connection,
    result: SyncResult,
    now = '2026-11-05T12:00:00.000Z',
    options?: TransactionSyncOptions,
  ) {
    const acc = planAccountSync({
      connectionId: connection.id,
      existing: this.accounts,
      result,
      now,
      newId: this.newId,
    });
    this.accounts.push(...acc.inserts);
    for (const u of acc.updates)
      Object.assign(this.accounts.find((a) => a.id === u.id) as Account, u.changes);

    const txn = planTransactionSync({
      connectionId: connection.id,
      accounts: acc.accountIds,
      existing: this.transactions,
      result,
      now,
      newId: this.newId,
      options,
    });
    for (const u of txn.updates)
      Object.assign(this.transactions.find((t) => t.id === u.id) as Transaction, u.changes);
    this.transactions.push(...txn.inserts);
    const removed = new Set(txn.removals.map((r) => r.id));
    this.transactions = this.transactions.filter((t) => !removed.has(t.id));

    const inv = planInvestmentSync({
      connectionId: connection.id,
      accounts: acc.accountIds,
      securities: this.securities,
      holdings: this.holdings,
      taxLots: this.taxLots,
      activities: this.activities,
      result,
      now,
      newId: this.newId,
    });
    this.securities.push(...inv.securityInserts);
    this.holdings.push(...inv.holdingInserts);
    for (const u of inv.holdingUpdates)
      Object.assign(this.holdings.find((h) => h.id === u.id) as Holding, u.changes);
    const goneHoldings = new Set(inv.holdingRemovals);
    this.holdings = this.holdings.filter((h) => !goneHoldings.has(h.id));
    this.taxLots.push(...inv.lotInserts);
    for (const u of inv.lotUpdates)
      Object.assign(this.taxLots.find((l) => l.id === u.id) as TaxLot, u.changes);
    const goneLots = new Set(inv.lotRemovals);
    this.taxLots = this.taxLots.filter((l) => !goneLots.has(l.id));
    this.activities.push(...inv.activityInserts);
    for (const u of inv.activityUpdates)
      Object.assign(this.activities.find((a) => a.id === u.id) as InvestmentActivity, u.changes);
    return { acc, txn, inv };
  }
}
