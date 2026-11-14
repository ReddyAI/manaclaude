import { act, screen } from '@testing-library/react-native';
import {
  classifyAccountType,
  convertAmount,
  DEFAULT_SETTINGS,
  type Account,
  type AccountWithManualBalance,
  type FinanceDataset,
  type Goal,
} from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import { currentNetWorth, netWorthByType, netWorthHistory } from '../../../data/metrics';
import { updateSettings } from '../../../data/settingsStore';
import { setFinance } from '../../../data/store';
import { AccountsScreen } from '../../accounts/AccountsScreen';
import { goalStatus, leftOutText } from '../../planning/goalStatus';
import { PlanningScreen } from '../../planning/PlanningScreen';
import { renderScreen } from '../../planning/__tests__/helpers';
import { NetWorthScreen } from '../NetWorthScreen';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

// All data is invented.
/** The account as the Worker sends one whose balance nobody entered: 0 is a placeholder. */
function unknown(a: Account, includeInNetWorth = false): AccountWithManualBalance {
  return {
    ...a,
    balance: 0,
    includeInNetWorth,
    manualBalance: { currentKnown: false, openingBalance: null },
  };
}
/** Like `unknown`, but with a leftover number in place of the placeholder, to show it is ignored. */
function unknownWithNumber(a: Account): AccountWithManualBalance {
  return { ...unknown(a, true), balance: 123_456_00 };
}
function withAccounts(change: (a: Account) => Account): FinanceDataset {
  const d = createSampleData();
  return { ...d, accounts: d.accounts.map(change) };
}
const sumUsd = (d: FinanceDataset, keep: (a: Account) => boolean, kind: 'asset' | 'liability') =>
  d.accounts
    .filter((a) => keep(a) && classifyAccountType(a.type) === kind)
    .reduce((s, a) => s + (convertAmount(a.balance, a.currency, 'USD', d.fxRates) ?? 0), 0);

describe('net worth counts only known balances that are switched in', () => {
  it('leaves out an unknown balance even when the switch says to count it', () => {
    const plain = createSampleData();
    const d = withAccounts((a) => (a.id === 'acc_savings' ? unknownWithNumber(a) : a));
    const before = currentNetWorth(plain, 'USD');
    const savings = plain.accounts.find((a) => a.id === 'acc_savings')!;
    const after = currentNetWorth(d, 'USD');
    expect(after.assets).toBe(before.assets - savings.balance);
    expect(netWorthHistory(d, 'USD').length).toBeGreaterThan(0);
    const historyIds = new Set(d.balanceHistory.map((s) => s.accountId));
    expect(historyIds.has('acc_savings')).toBe(true);
    // The history leaves its snapshots out too.
    const withSavings = netWorthHistory(plain, 'USD');
    const withoutSavings = netWorthHistory(d, 'USD');
    expect(withoutSavings).not.toEqual(withSavings);
  });

  it('splits by kind exactly what net worth counts', () => {
    const d = withAccounts((a) =>
      a.id === 'acc_savings'
        ? { ...a, includeInNetWorth: false }
        : a.id === 'acc_nre'
          ? unknownWithNumber(a)
          : a,
    );
    const { byType, unknown: left } = netWorthByType(d, 'USD');
    const nw = currentNetWorth(d, 'USD');
    let assets = 0;
    let liabilities = 0;
    for (const [type, v] of byType)
      if (classifyAccountType(type) === 'asset') assets += v;
      else liabilities += v;
    expect(assets).toBe(nw.assets);
    expect(liabilities).toBe(nw.liabilities);
    const counted = (a: Account) => a.includeInNetWorth && a.id !== 'acc_nre';
    expect(nw.assets).toBe(sumUsd(d, counted, 'asset'));
    const savingsType = d.accounts.find((a) => a.id === 'acc_savings')!.type;
    const savingsKind = d.accounts
      .filter((a) => a.type === savingsType && counted(a))
      .reduce((s, a) => s + (convertAmount(a.balance, a.currency, 'USD', d.fxRates) ?? 0), 0);
    expect(byType.get(savingsType) ?? 0).toBe(savingsKind);
    expect(left.map((a) => a.id)).toEqual(['acc_nre']);
  });

  it('says on the Net worth screen which account it leaves out', async () => {
    await act(async () => {
      setFinance(withAccounts((a) => (a.id === 'acc_nre' ? unknown(a) : a)));
      updateSettings({ ...DEFAULT_SETTINGS });
    });
    await renderScreen(<NetWorthScreen />);
    const name = createSampleData().accounts.find((a) => a.id === 'acc_nre')!.name;
    expect(screen.getByTestId('networth-unknown').props.children).toBe(
      `Leaves out "${name}": its balance is unknown. Enter it on the account's page to count it.`,
    );
  });

  it('says nothing when every balance is known', async () => {
    await act(async () => setFinance(createSampleData()));
    await renderScreen(<NetWorthScreen />);
    expect(screen.queryByTestId('networth-unknown')).toBeNull();
  });
});

describe('goals leave out accounts whose value is unknown', () => {
  const d = createSampleData();
  const goal = (over: Partial<Goal>): Goal => ({ ...d.goals[0]!, ...over });
  const savings = d.accounts.find((a) => a.id === 'acc_savings')!;

  it('counts known accounts and lists the unknown one', () => {
    const accounts = d.accounts.map((a) => (a.id === 'acc_checking' ? unknownWithNumber(a) : a));
    const g = goal({ accountIds: ['acc_savings', 'acc_checking'], currency: savings.currency });
    const s = goalStatus(g, accounts, d.fxRates, '2026-11');
    expect(s.progress!.current).toBe(savings.balance);
    expect(s.leftOut).toEqual([
      {
        accountId: 'acc_checking',
        name: accounts.find((a) => a.id === 'acc_checking')!.name,
        reason: 'unknown_balance',
      },
    ]);
    expect(leftOutText(g, s.leftOut)).toMatch(/^Leaves out ".+" \(balance unknown\)\.$/);
  });

  it('has no progress when every linked account is unknown', () => {
    const accounts = d.accounts.map((a) => (a.id === 'acc_savings' ? unknown(a) : a));
    const s = goalStatus(goal({ accountIds: ['acc_savings'] }), accounts, d.fxRates, '2026-11');
    expect(s.progress).toBeNull();
  });

  it('does not count an unknown debt as paid off', () => {
    const card = d.accounts.find((a) => classifyAccountType(a.type) === 'liability')!;
    const accounts = d.accounts.map((a) => (a.id === card.id ? unknown(a) : a));
    const g = goal({ kind: 'debt_payoff', accountIds: [card.id], currency: card.currency });
    expect(goalStatus(g, accounts, d.fxRates, '2026-11').progress).toBeNull();
  });

  it('leaves out an account with no exchange rate and one no longer in the data', () => {
    const g = goal({ accountIds: ['acc_savings', 'acc_gone'], currency: 'EUR' });
    const s = goalStatus(g, d.accounts, [], '2026-11');
    expect(s.progress).toBeNull();
    expect(s.leftOut.map((l) => l.reason)).toEqual(['no_rate', 'missing']);
    expect(leftOutText(g, s.leftOut)).toBe(
      `Leaves out "${savings.name}" (no exchange rate to EUR), an account no longer in your data.`,
    );
  });

  it('keeps a goal with no accounts on its typed progress', () => {
    const g = goal({ accountIds: [], manualProgress: 1_000_00 });
    expect(goalStatus(g, d.accounts, d.fxRates, '2026-11').progress!.current).toBe(1_000_00);
  });

  it('shows Unknown and the reason on the Planning screen', async () => {
    await act(async () => {
      setFinance(withAccounts((a) => (a.id === 'acc_savings' ? unknown(a) : a)));
      updateSettings({ ...DEFAULT_SETTINGS, planning: undefined });
    });
    await renderScreen(<PlanningScreen />);
    expect(screen.getByTestId('goal-unknown-goal_emergency')).toBeTruthy();
    expect(screen.getByTestId('goal-left-out-goal_emergency').props.children).toBe(
      `Progress is not known. Leaves out "${savings.name}" (balance unknown).`,
    );
    expect(screen.queryByTestId('goal-unknown-goal_india_home')).toBeNull();
  });
});

describe('retirement planning', () => {
  it('starts from investment accounts with known balances only', async () => {
    const shown = async (d: FinanceDataset) => {
      await act(async () => {
        setFinance(d);
        updateSettings({ ...DEFAULT_SETTINGS, planning: undefined });
      });
      const view = await renderScreen(<PlanningScreen />);
      const text = JSON.stringify(screen.getByTestId('fire-at-retirement'));
      await view.unmount();
      return text;
    };
    const switchedOut = await shown(
      withAccounts((a) => (a.id === 'acc_brokerage' ? { ...a, includeInNetWorth: false } : a)),
    );
    const unknownOne = await shown(
      withAccounts((a) => (a.id === 'acc_brokerage' ? unknownWithNumber(a) : a)),
    );
    expect(unknownOne).toBe(switchedOut);
    expect(await shown(createSampleData())).not.toBe(switchedOut);
  });
});

describe('Accounts group totals', () => {
  it('say which account the total leaves out', async () => {
    await act(async () =>
      setFinance(withAccounts((a) => (a.id === 'acc_savings' ? unknown(a) : a))),
    );
    await renderScreen(<AccountsScreen />);
    const note = screen.getByText(/^The total leaves out ".+": its balance is unknown\.$/);
    expect(note.props.children).toContain(
      createSampleData().accounts.find((a) => a.id === 'acc_savings')!.name,
    );
  });
});
