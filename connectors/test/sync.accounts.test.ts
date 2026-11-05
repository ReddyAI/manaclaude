import { describe, expect, it } from 'vitest';
import type { Account } from '@manaclaude/shared';
import { planAccountSync } from '../src/sync';
import { providerAccount } from '../src/kit';

const NOW = '2026-11-05T12:00:00.000Z';
let n = 0;
const newId = (k: string) => `${k}_n${++n}`;

function acct(over: Partial<Account> = {}): Account {
  return {
    id: 'acc_1',
    name: 'My renamed checking',
    institutionName: null,
    type: 'checking',
    subtype: null,
    currency: 'USD',
    balance: 100,
    balanceAsOf: '2026-11-01T00:00:00.000Z',
    availableBalance: null,
    creditLimit: null,
    mask: null,
    connectionId: 'conn_1',
    externalId: 'ext_1',
    includeInNetWorth: true,
    hidden: false,
    isDefaultCash: false,
    interestRate: null,
    openedOn: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}
const prov = (over = {}) =>
  providerAccount({
    externalId: 'ext_1',
    name: 'Everyday Checking',
    type: 'checking',
    currency: 'USD',
    balance: 5000,
    ...over,
  });

describe('account sync', () => {
  it('creates accounts for new provider accounts and records a balance snapshot', () => {
    const out = planAccountSync({
      connectionId: 'conn_1',
      institutionName: 'Lakeshore Bank',
      existing: [],
      result: {
        accounts: [
          prov(),
          prov({
            externalId: 'ext_2',
            name: 'Card',
            type: 'credit_card',
            balance: 12_000,
            creditLimit: 100_000,
            interestRate: '24.99',
          }),
        ],
      },
      now: NOW,
      newId,
    });
    expect(out.inserts).toHaveLength(2);
    expect(out.inserts[0]).toMatchObject({
      connectionId: 'conn_1',
      externalId: 'ext_1',
      institutionName: 'Lakeshore Bank',
      balance: 5000,
      hidden: false,
      includeInNetWorth: true,
    });
    expect(out.inserts[1]).toMatchObject({
      type: 'credit_card',
      balance: 12_000,
      creditLimit: 100_000,
      interestRate: '24.99',
    });
    expect(out.balanceSnapshots).toEqual([
      { accountId: out.inserts[0]?.id, date: '2026-11-05', balance: 5000, currency: 'USD' },
      { accountId: out.inserts[1]?.id, date: '2026-11-05', balance: 12_000, currency: 'USD' },
    ]);
    expect([...out.accountIds.keys()]).toEqual(['ext_1', 'ext_2']);
  });

  it('refreshes balance but never renames an account the user renamed', () => {
    const out = planAccountSync({
      connectionId: 'conn_1',
      existing: [acct()],
      result: { accounts: [prov({ mask: '4821' })] },
      now: NOW,
      newId,
    });
    expect(out.inserts).toEqual([]);
    expect(out.updates).toHaveLength(1);
    expect(out.updates[0]?.changes).toMatchObject({
      balance: 5000,
      mask: '4821',
      balanceAsOf: NOW,
    });
    expect(out.updates[0]?.changes).not.toHaveProperty('name');
    expect(out.accountIds.get('ext_1')).toBe('acc_1');
  });

  it('keeps the account currency when the provider changes it and says so', () => {
    const out = planAccountSync({
      connectionId: 'conn_1',
      existing: [acct()],
      result: { accounts: [prov({ currency: 'EUR' })] },
      now: NOW,
      newId,
    });
    expect(out.updates[0]?.changes).not.toHaveProperty('currency');
    expect(out.warnings[0]).toMatch(/EUR/);
  });

  it('one connector per account: an account owned by another connection is reported, not synced', () => {
    const owned = acct({ connectionId: 'conn_other' });
    const out = planAccountSync({
      connectionId: 'conn_1',
      existing: [owned],
      result: { accounts: [prov()] },
      now: NOW,
      newId,
    });
    expect(out.inserts).toEqual([]);
    expect(out.updates).toEqual([]);
    expect(out.conflicts).toEqual([
      { externalId: 'ext_1', existingAccountId: 'acc_1', otherConnectionId: 'conn_other' },
    ]);
  });

  it('lists accounts of this connection that the provider no longer returns', () => {
    const gone = acct({ id: 'acc_gone', externalId: 'ext_gone' });
    const out = planAccountSync({
      connectionId: 'conn_1',
      existing: [acct(), gone],
      result: { accounts: [prov()] },
      now: NOW,
      newId,
    });
    expect(out.missingAccountIds).toEqual(['acc_gone']);
  });

  it('ignores a provider account listed twice', () => {
    const out = planAccountSync({
      connectionId: 'conn_1',
      existing: [],
      result: { accounts: [prov(), prov()] },
      now: NOW,
      newId,
    });
    expect(out.inserts).toHaveLength(1);
  });
});
