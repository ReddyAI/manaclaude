import type { Account, AccountWithManualBalance } from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import {
  checkAccountEdit,
  chooseBalance,
  draftFrom,
  isProviderAccount,
  kindLock,
  matchesEdit,
  readOnlyReason,
} from '../accountEdit';
import { blockerText, quickCashText, removalEffects } from '../accountRemoval';

/** All data is invented. */
const TODAY = '2026-11-14';
const base = createSampleData();
const nre = base.accounts.find((a) => a.id === 'acc_nre')!;
const cash = base.accounts.find((a) => a.id === 'acc_cash_inr')!;
const unknown: AccountWithManualBalance = {
  ...nre,
  id: 'acc_unknown',
  name: 'Old savings',
  balance: 0,
  includeInNetWorth: false,
  manualBalance: { currentKnown: false, openingBalance: { amount: 5000_00, date: '2026-03-01' } },
};
const ctx = (account: Account) => ({ today: TODAY, kindLock: kindLock(account, base) });

describe('the account edit form', () => {
  it('starts an unknown balance as unknown and empty, never as 0', () => {
    const d = draftFrom(unknown, TODAY);
    expect(d.balance).toBe('unknown');
    expect(d.amount).toBe('');
    expect(d.includeInNetWorth).toBe(false);
  });

  it('sends only what changed, trimmed', () => {
    const d = { ...draftFrom(nre, TODAY), name: '  NRE Savings 2 ' };
    expect(checkAccountEdit(d, nre, ctx(nre)).body).toEqual({ name: 'NRE Savings 2' });
    expect(checkAccountEdit(draftFrom(nre, TODAY), nre, ctx(nre))).toMatchObject({
      body: null,
      unchanged: true,
    });
  });

  it('always sends the net worth choice with a new balance, on noon UTC of its day', () => {
    const d = { ...draftFrom(nre, TODAY), amount: '1,000.50', asOfDate: '2026-11-10' };
    const r = checkAccountEdit(d, nre, ctx(nre));
    expect(r.balanceChanged).toBe(true);
    expect(r.body).toEqual({
      currentBalance: { amount: 1000_50, asOf: '2026-11-10T12:00:00.000Z' },
      includeInNetWorth: true,
    });
  });

  it('turns net worth on when an unknown balance becomes known, and off when it becomes unknown', () => {
    const known = chooseBalance(draftFrom(unknown, TODAY), 'known', unknown);
    expect(known.includeInNetWorth).toBe(true);
    const r = checkAccountEdit({ ...known, amount: '7000' }, unknown, ctx(unknown));
    expect(r.body).toEqual({
      currentBalance: { amount: 7000_00, asOf: `${TODAY}T12:00:00.000Z` },
      includeInNetWorth: true,
    });
    const off = chooseBalance(draftFrom(nre, TODAY), 'unknown', nre);
    expect(off.includeInNetWorth).toBe(false);
    expect(checkAccountEdit(off, nre, ctx(nre)).body).toEqual({
      currentBalance: null,
      includeInNetWorth: false,
    });
  });

  it('sends the switch alone when only it changed', () => {
    const d = { ...draftFrom(nre, TODAY), includeInNetWorth: false };
    expect(checkAccountEdit(d, nre, ctx(nre)).body).toEqual({ includeInNetWorth: false });
  });

  it('refuses what the Worker would refuse', () => {
    const d = draftFrom(nre, TODAY);
    expect(checkAccountEdit({ ...d, name: ' ' }, nre, ctx(nre)).problems.name).toBe('Type a name.');
    expect(checkAccountEdit({ ...d, amount: '1.234' }, nre, ctx(nre)).problems.amount).toMatch(
      /2 decimals/,
    );
    expect(checkAccountEdit({ ...d, asOfDate: '2026-02-30' }, nre, ctx(nre)).problems.date).toMatch(
      /real date/,
    );
    expect(checkAccountEdit({ ...d, asOfDate: '2026-11-15' }, nre, ctx(nre)).problems.date).toMatch(
      /after today/,
    );
    const k = chooseBalance(draftFrom(unknown, TODAY), 'known', unknown);
    expect(
      checkAccountEdit({ ...k, amount: '1', asOfDate: '2026-02-01' }, unknown, ctx(unknown))
        .problems.date,
    ).toMatch(/opening balance date \(2026-03-01\)/);
    const c = draftFrom(cash, TODAY);
    expect(checkAccountEdit({ ...c, amount: '-5' }, cash, ctx(cash)).problems.amount).toMatch(
      /below zero/,
    );
    expect(checkAccountEdit({ ...c, type: 'savings' }, cash, ctx(cash)).problems.type).toMatch(
      /stays a cash account/,
    );
    expect(checkAccountEdit({ ...d, type: 'cash' }, nre, ctx(nre)).problems.type).toMatch(
      /cannot become a cash account/,
    );
  });

  it('allows a negative balance on a non-cash account (overdrawn, or a credit on a debt)', () => {
    const d = { ...draftFrom(nre, TODAY), amount: '-20' };
    expect(checkAccountEdit(d, nre, ctx(nre)).body?.currentBalance).toMatchObject({
      amount: -20_00,
    });
  });

  it('locks the kind of an account with investment records', () => {
    const brokerage = { ...nre, id: 'acc_inv' };
    const data = { holdings: [{ ...base.holdings[0]!, accountId: 'acc_inv' }], activities: [] };
    expect(kindLock(brokerage, data)).toMatch(/investment records/);
    expect(
      checkAccountEdit({ ...draftFrom(brokerage, TODAY), type: 'checking' }, brokerage, {
        today: TODAY,
        kindLock: kindLock(brokerage, data),
      }).body,
    ).toBeNull();
  });

  it('treats a connection or a provider id as read-only, with the reason', () => {
    const linked = base.accounts.find((a) => a.connectionId)!;
    expect(isProviderAccount(linked)).toBe(true);
    expect(isProviderAccount({ connectionId: null, externalId: 'ext_1' })).toBe(true);
    expect(isProviderAccount(nre)).toBe(false);
    expect(readOnlyReason(linked, base.connections)).toMatch(/can't be changed here/);
  });

  it('knows when the Worker already has the edit', () => {
    const body = {
      name: 'NRE 2',
      currentBalance: { amount: 10_00, asOf: '2026-11-10T12:00:00.000Z' },
      includeInNetWorth: true,
    };
    const saved = { ...nre, name: 'NRE 2', balance: 10_00, balanceAsOf: '2026-11-10T12:00:00Z' };
    expect(matchesEdit(saved, body)).toBe(true);
    expect(matchesEdit({ ...saved, balance: 11_00 }, body)).toBe(false);
    expect(matchesEdit({ ...saved, name: 'NRE' }, body)).toBe(false);
    expect(matchesEdit(unknown, { currentBalance: null })).toBe(true);
    expect(matchesEdit(nre, { currentBalance: null })).toBe(false);
  });
});

describe('the deletion preview in plain words', () => {
  const counts = {
    transactions: 3,
    balanceSnapshots: 2,
    holdings: 0,
    investmentActivities: 0,
    recurringItems: 2,
    goals: 0,
    rules: 1,
    imports: 1,
    savedLayouts: 0,
    savingImports: 1,
  };

  it('says every blocker with what to do first', () => {
    expect(blockerText('account_not_empty', { counts }).what).toMatch(/3 transactions/);
    expect(blockerText('account_not_empty', { counts }).todo).toMatch(/Undo the import/);
    expect(blockerText('account_in_use', { counts }).what).toBe(
      'Other records still point at it: 2 recurring items and 1 rule.',
    );
    expect(blockerText('import_in_progress', { counts }).what).toMatch(/1 import in progress/);
    expect(blockerText('account_delete_too_large', { counts }).what).toMatch(/3 balance readings/);
    expect(blockerText('account_connected', { counts }).todo).toMatch(/cannot be removed here/);
  });

  it('lists what removal does', () => {
    const lines = removalEffects({
      accountId: 'a',
      account: nre,
      previewToken: 'x',
      allowed: true,
      blockers: [],
      counts,
      removes: { accounts: 1, balanceSnapshots: 2, manualBalance: true },
      detaches: { imports: 1, savedLayouts: 0 },
      defaultCash: null,
    });
    expect(lines.join(' ')).toMatch(/2 saved balance readings/);
    expect(lines.join(' ')).toMatch(/balance you entered by hand/);
    expect(lines.join(' ')).toMatch(/1 import that used it keeps the file/);
  });

  it('says which cash wallet takes quick entries, before and after', () => {
    const accounts = [{ id: 'acc_w2', name: 'Pouch' }];
    const next = { wasDefault: true, nextAccountId: 'acc_w2', createsOnNextUse: false };
    expect(quickCashText(next, cash, accounts)).toMatch(/After removal they go to "Pouch"/);
    expect(quickCashText(next, cash, accounts, 'after')).toBe(
      'Quick cash entries in INR now go to "Pouch".',
    );
    expect(
      quickCashText({ wasDefault: true, nextAccountId: null, createsOnNextUse: true }, cash, []),
    ).toMatch(/new one called "Cash \(INR\)"/);
    expect(quickCashText(null, nre, [])).toBeNull();
  });
});
