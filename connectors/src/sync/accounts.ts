import type {
  Account,
  BalanceSnapshot,
  Id,
  IsoDateTime,
  ProviderAccount,
  SyncResult,
} from '@manaclaude/shared';
import { defaultIdFactory, type IdFactory, type Update } from './types';

/**
 * Accounts part of a sync: create accounts for new provider accounts, refresh
 * balances of known ones, and report conflicts with the "one connector per
 * account" rule. Follows Sure's PlaidAccount::Processor#process_account! and the
 * other *_account processors: name and type are set once, balance is refreshed.
 */

export interface AccountSyncInput {
  connectionId: Id;
  /** Name of the institution when the provider account has none. */
  institutionName?: string | null;
  /** Every existing account of the app (the function needs them all to spot conflicts). */
  existing: readonly Account[];
  result: Pick<SyncResult, 'accounts'>;
  now: IsoDateTime;
  newId?: IdFactory;
}

export interface AccountConflict {
  externalId: string;
  existingAccountId: Id;
  otherConnectionId: Id | null;
}

export interface AccountSyncOutput {
  inserts: Account[];
  updates: Update<Account>[];
  /** Provider account id to our Account id for every account of this connection after the sync. */
  accountIds: Map<string, Id>;
  /** Provider accounts that already belong to another connection. They are not synced. */
  conflicts: AccountConflict[];
  /** Accounts of this connection that the provider no longer lists. Keep them; the app can offer to hide them. */
  missingAccountIds: Id[];
  balanceSnapshots: BalanceSnapshot[];
  warnings: string[];
}

function toAccount(
  p: ProviderAccount,
  connectionId: Id,
  fallbackInstitution: string | null,
  now: IsoDateTime,
  id: Id,
): Account {
  return {
    id,
    name: p.name,
    institutionName: p.institutionName ?? fallbackInstitution,
    type: p.type,
    subtype: p.subtype,
    currency: p.currency,
    balance: p.balance,
    balanceAsOf: now,
    availableBalance: p.availableBalance,
    creditLimit: p.creditLimit,
    mask: p.mask,
    connectionId,
    externalId: p.externalId,
    includeInNetWorth: true,
    hidden: false,
    isDefaultCash: false,
    interestRate: null,
    openedOn: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function planAccountSync(input: AccountSyncInput): AccountSyncOutput {
  const newId = input.newId ?? defaultIdFactory;
  const out: AccountSyncOutput = {
    inserts: [],
    updates: [],
    accountIds: new Map(),
    conflicts: [],
    missingAccountIds: [],
    balanceSnapshots: [],
    warnings: [],
  };
  const today = input.now.slice(0, 10);
  const seen = new Set<string>();

  for (const p of input.result.accounts) {
    if (seen.has(p.externalId)) continue;
    seen.add(p.externalId);
    const mine = input.existing.find(
      (a) => a.externalId === p.externalId && a.connectionId === input.connectionId,
    );
    const elsewhere = mine
      ? undefined
      : input.existing.find((a) => a.externalId === p.externalId && a.connectionId !== null);

    if (elsewhere) {
      out.conflicts.push({
        externalId: p.externalId,
        existingAccountId: elsewhere.id,
        otherConnectionId: elsewhere.connectionId,
      });
      continue;
    }

    if (!mine) {
      const row = toAccount(
        p,
        input.connectionId,
        input.institutionName ?? null,
        input.now,
        newId('acc'),
      );
      out.inserts.push(row);
      out.accountIds.set(p.externalId, row.id);
      out.balanceSnapshots.push({
        accountId: row.id,
        date: today,
        balance: p.balance,
        currency: p.currency,
      });
      continue;
    }

    out.accountIds.set(p.externalId, mine.id);
    const changes: Partial<Account> = {};
    if (mine.balance !== p.balance) changes.balance = p.balance;
    if (mine.availableBalance !== p.availableBalance) changes.availableBalance = p.availableBalance;
    if (p.creditLimit !== null && mine.creditLimit !== p.creditLimit)
      changes.creditLimit = p.creditLimit;
    if (p.mask !== null && mine.mask !== p.mask) changes.mask = p.mask;
    if (mine.institutionName === null && (p.institutionName ?? input.institutionName)) {
      changes.institutionName = p.institutionName ?? input.institutionName ?? null;
    }
    if (mine.subtype === null && p.subtype !== null) changes.subtype = p.subtype;
    if (mine.currency !== p.currency) {
      // Moving an account to another currency would orphan its transactions.
      out.warnings.push(
        `${mine.name}: provider currency ${p.currency} differs from ${mine.currency}; kept ${mine.currency}`,
      );
    }
    // The balance as of now, even when unchanged, so the freshness date moves.
    changes.balanceAsOf = input.now;
    if (Object.keys(changes).length > 1 || mine.balance !== p.balance)
      changes.updatedAt = input.now;
    out.updates.push({ id: mine.id, changes, reason: 'refresh' });
    out.balanceSnapshots.push({
      accountId: mine.id,
      date: today,
      balance: p.balance,
      currency: mine.currency,
    });
  }

  for (const a of input.existing) {
    if (a.connectionId === input.connectionId && a.externalId && !seen.has(a.externalId)) {
      out.missingAccountIds.push(a.id);
    }
  }
  return out;
}
