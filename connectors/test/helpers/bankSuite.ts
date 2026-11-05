import { describe, expect, it } from 'vitest';
import type {
  Connection,
  ConnectorAdapter,
  ConnectorContext,
  ProviderAccount,
  ProviderTransaction,
  Transaction,
} from '@manaclaude/shared';
import { makeConnection } from './fakeFetch';
import { expectRepairOnExpiredToken, expectRepeatSyncIsQuiet, expectSyncShape } from './contract';
import { MemoryStore } from './store';

/**
 * The checks every bank-style adapter shares, driven by a short description:
 * shape, account mapping, sign conversion per transaction, repeat syncs, two
 * identical purchases, pending to posted, expired token to needs_repair, and
 * the health badge. Adapter-specific tests sit next to it in each test file.
 */
export interface BankSuite {
  name: string;
  adapter: ConnectorAdapter;
  /** A context that answers with the saved sample responses. `posted` is the later sync where holds have posted. */
  ctx: (variant?: 'default' | 'posted') => ConnectorContext;
  connection?: Connection;
  accounts: Record<string, Partial<ProviderAccount>>;
  /** Expected fields per provider transaction id; amount is the sign-rule check. */
  transactions: Record<string, Partial<ProviderTransaction>>;
  /** Two real purchases with the same date and amount that both must survive. */
  identical?: { date: string; amount: number; count?: number };
  /** The pending row seeded by the default sync and the posted id that replaces it in the `posted` variant. */
  pending?: { pendingId: string; postedId: string };
  /** Contexts whose first call is answered as an expired or revoked login. */
  repair: (() => ConnectorContext)[];
  /** Context for a working health probe, and one for an expired login. */
  health?: { ok: () => ConnectorContext; expired: () => ConnectorContext };
}

export function describeBankSuite(s: BankSuite): void {
  const connection = s.connection ?? makeConnection(s.adapter.id);

  describe(`${s.name} (shared bank checks)`, () => {
    it('returns well-formed accounts and transactions', async () => {
      await expectSyncShape(await s.adapter.sync(s.ctx(), connection));
    });

    it('maps accounts as the model expects (balances: owed is positive for cards and loans)', async () => {
      const { accounts } = await s.adapter.sync(s.ctx(), connection);
      const byId = new Map(accounts.map((a) => [a.externalId, a]));
      for (const [id, expected] of Object.entries(s.accounts)) {
        expect(byId.get(id), `account ${id}`).toMatchObject(expected);
      }
    });

    it('follows the sign rule: negative is money out', async () => {
      const { transactions } = await s.adapter.sync(s.ctx(), connection);
      const byId = new Map(transactions.map((t) => [t.externalId, t]));
      for (const [id, expected] of Object.entries(s.transactions)) {
        expect(byId.get(id), `transaction ${id}`).toMatchObject(expected);
      }
    });

    it('adds nothing on a repeat sync', async () => {
      const { store } = await expectRepeatSyncIsQuiet(s.adapter, () => s.ctx(), connection);
      if (s.identical) {
        const same = store.transactions.filter(
          (t: Transaction) => t.date === s.identical!.date && t.amount === s.identical!.amount,
        );
        expect(same).toHaveLength(s.identical.count ?? 2);
        expect(new Set(same.map((t) => t.externalId)).size).toBe(same.length);
      }
    });

    if (s.pending) {
      const pending = s.pending;
      it('turns the pending hold into its posted row without a duplicate', async () => {
        const store = new MemoryStore();
        const first = await s.adapter.sync(s.ctx(), connection);
        store.apply(connection, first);
        const hold = store.transactions.find((t) => t.externalId === pending.pendingId);
        expect(hold?.pending).toBe(true);
        const before = store.transactions.length;
        const second = await s.adapter.sync(s.ctx('posted'), {
          ...connection,
          syncCursor: first.nextCursor,
        });
        const { txn } = store.apply(connection, second, '2026-11-06T12:00:00.000Z');
        const row = store.transactions.find((t) => t.id === hold?.id);
        expect(row).toMatchObject({ externalId: pending.postedId, pending: false });
        expect(txn.stats.postedFromPending).toBe(1);
        expect(
          store.transactions.filter(
            (t) => t.amount === hold?.amount && t.name === hold?.name && t.pending,
          ),
        ).toHaveLength(0);
        expect(store.transactions.length).toBeLessThanOrEqual(before + 1);
      });
    }

    it('asks for repair when the login is rejected', async () => {
      for (const make of s.repair) await expectRepairOnExpiredToken(s.adapter, make, connection);
    });

    if (s.health) {
      const health = s.health;
      it('reports health from a cheap call', async () => {
        expect(await s.adapter.checkHealth?.(health.ok(), connection)).toBe('healthy');
        expect(await s.adapter.checkHealth?.(health.expired(), connection)).toBe('needs_repair');
      });
    }
  });
}
