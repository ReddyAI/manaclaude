import { act, screen } from '@testing-library/react-native';
import {
  convertAmount,
  DEFAULT_SETTINGS,
  type Account,
  type AccountWithManualBalance,
  type FinanceDataset,
} from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import { accountsWithoutRate, currentNetWorth, netWorthByType } from '../../../data/metrics';
import { updateSettings } from '../../../data/settingsStore';
import { setFinance } from '../../../data/store';
import { AccountsScreen } from '../../accounts/AccountsScreen';
import { DashboardScreen } from '../../dashboard/DashboardScreen';
import { PlanningScreen } from '../../planning/PlanningScreen';
import { renderScreen } from '../../planning/__tests__/helpers';
import { homeLeftOutText, noRateText } from '../leftOut';
import { NetWorthScreen } from '../NetWorthScreen';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn() },
  useLocalSearchParams: () => ({}),
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('../../../design/haptics', () => ({
  ...jest.requireActual('../../../design/haptics'),
  haptic: jest.fn(),
}));

// All data is invented. The sample rates cover USD, INR and EUR, not CHF or GBP.
const base = createSampleData();
const cashUsd = base.accounts.find((a) => a.id === 'acc_cash_usd')!;
const brokerage = base.accounts.find((a) => a.id === 'acc_brokerage')!;
const chfWallet: Account = {
  ...cashUsd,
  id: 'acc_cash_chf',
  name: 'Zurich wallet',
  currency: 'CHF',
  balance: 120_00,
  isDefaultCash: true,
};
const gbpIsa: Account = {
  ...brokerage,
  id: 'acc_isa_gbp',
  name: 'London ISA',
  currency: 'GBP',
  balance: 5_000_00,
  connectionId: null,
  externalId: null,
};
const withExtra = (...extra: Account[]): FinanceDataset => ({
  ...base,
  accounts: [...base.accounts, ...extra],
});

describe('accounts with no exchange rate', () => {
  it('are left out of the total and listed', () => {
    const d = withExtra(chfWallet);
    const plain = currentNetWorth(base, 'USD');
    const nw = currentNetWorth(d, 'USD');
    expect(nw.assets).toBe(plain.assets);
    expect(nw.noRate.map((a) => a.id)).toEqual(['acc_cash_chf']);
    expect(plain.noRate).toEqual([]);
    expect(netWorthByType(d, 'USD').noRate.map((a) => a.id)).toEqual(['acc_cash_chf']);
  });

  it('only lists accounts net worth would count', () => {
    const unknown: AccountWithManualBalance = {
      ...chfWallet,
      id: 'acc_chf_unknown',
      includeInNetWorth: false,
      manualBalance: { currentKnown: false, openingBalance: null },
    };
    const out = { ...chfWallet, id: 'acc_chf_out', includeInNetWorth: false };
    expect(currentNetWorth(withExtra(unknown, out), 'USD').noRate).toEqual([]);
  });

  it('finds the accounts a rate is missing for, in any currency', () => {
    const eur = { ...chfWallet, id: 'acc_eur', currency: 'EUR' };
    expect(convertAmount(100, 'EUR', 'INR', base.fxRates)).not.toBeNull();
    expect(
      accountsWithoutRate([chfWallet, eur, cashUsd], 'INR', base.fxRates).map((a) => a.id),
    ).toEqual(['acc_cash_chf']);
  });

  it('are named in plain words', () => {
    expect(noRateText([chfWallet], 'USD')).toBe(
      'Leaves out "Zurich wallet": there is no CHF to USD exchange rate yet, so it adds nothing. Refresh rates in Settings, Exchange rates.',
    );
    expect(noRateText([chfWallet, gbpIsa], 'USD')).toBe(
      'Leaves out 2 accounts with no exchange rate to USD: "Zurich wallet" (CHF), "London ISA" (GBP). Refresh rates in Settings, Exchange rates.',
    );
    expect(noRateText([], 'USD')).toBeNull();
    expect(homeLeftOutText([], [chfWallet], 'USD')).toBe(
      'Leaves out "Zurich wallet": no CHF to USD rate yet.',
    );
    expect(homeLeftOutText([gbpIsa], [chfWallet], 'USD')).toBe(
      'Leaves out 2 accounts with an unknown balance or no exchange rate. See Net worth.',
    );
    expect(homeLeftOutText([], [], 'USD')).toBeNull();
  });
});

describe('screens say what a total leaves out for a missing rate', () => {
  beforeEach(async () => {
    await act(async () => updateSettings({ ...DEFAULT_SETTINGS, planning: undefined }));
  });

  it('Net worth', async () => {
    await act(async () => setFinance(withExtra(chfWallet)));
    await renderScreen(<NetWorthScreen />);
    expect(screen.getByTestId('networth-no-rate').props.children).toBe(
      noRateText([chfWallet], 'USD'),
    );
  });

  it('Home, under the net worth', async () => {
    await act(async () => setFinance(withExtra(chfWallet)));
    await renderScreen(<DashboardScreen />);
    expect(screen.getByTestId('net-worth-left-out').props.children).toBe(
      'Leaves out "Zurich wallet": no CHF to USD rate yet.',
    );
  });

  it('Planning, under the starting savings', async () => {
    await act(async () => setFinance(withExtra(gbpIsa)));
    await renderScreen(<PlanningScreen />);
    expect(screen.getByTestId('plan-no-rate').props.children).toBe(noRateText([gbpIsa], 'USD'));
  });

  it('Accounts, under the group total', async () => {
    await act(async () => setFinance(withExtra(chfWallet)));
    await renderScreen(<AccountsScreen />);
    expect(screen.getByTestId('group-no-rate-Cash').props.children).toBe(
      'The total leaves out "Zurich wallet": there is no CHF to USD exchange rate yet.',
    );
  });

  it('Accounts, an unknown balance in another currency only as unknown', async () => {
    const unknown: AccountWithManualBalance = {
      ...chfWallet,
      balance: 0,
      includeInNetWorth: false,
      manualBalance: { currentKnown: false, openingBalance: null },
    };
    await act(async () => setFinance(withExtra(unknown)));
    await renderScreen(<AccountsScreen />);
    expect(screen.getByTestId('group-unknown-Cash')).toBeTruthy();
    expect(screen.queryByTestId('group-no-rate-Cash')).toBeNull();
  });

  it('nothing when every rate is there', async () => {
    await act(async () => setFinance(createSampleData()));
    const view = await renderScreen(<NetWorthScreen />);
    expect(screen.queryByTestId('networth-no-rate')).toBeNull();
    await view.unmount();
    const home = await renderScreen(<DashboardScreen />);
    expect(screen.queryByTestId('net-worth-left-out')).toBeNull();
    await home.unmount();
    const plan = await renderScreen(<PlanningScreen />);
    expect(screen.queryByTestId('plan-no-rate')).toBeNull();
    await plan.unmount();
    await renderScreen(<AccountsScreen />);
    expect(screen.queryByText(/exchange rate/)).toBeNull();
  });
});
