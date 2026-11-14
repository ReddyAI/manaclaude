import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { DEFAULT_SETTINGS, type FinanceDataset } from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import { setBackendConfigForTests } from '../../../data/backend/config';
import { setBackendStatus } from '../../../data/backend/status';
import { updateSettings } from '../../../data/settingsStore';
import { setFinance } from '../../../data/store';
import { AccountsScreen } from '../../accounts/AccountsScreen';
import { DashboardScreen } from '../../dashboard/DashboardScreen';
import { InvestmentsScreen } from '../../networth/InvestmentsScreen';
import { PlanningScreen } from '../../planning/PlanningScreen';
import { RecapScreen } from '../../recaps/RecapScreen';
import { RecurringScreen } from '../../recurring/RecurringScreen';
import { TransactionsScreen } from '../../transactions/TransactionsScreen';
import { AppearanceSection } from '../sections/AppearanceSection';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), navigate: jest.fn(), back: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn() }));
jest.mock('../../../design/haptics', () => ({
  ...jest.requireActual('../../../design/haptics'),
  haptic: jest.fn(),
}));

/**
 * Block U: what each screen says with nothing in it, and wording that
 * used to call two equal amounts "less" or "below".
 */

const inRoot = (ui: ReactElement) => <GestureHandlerRootView>{ui}</GestureHandlerRootView>;

function emptyData(): FinanceDataset {
  const d = createSampleData({ today: '2026-11-05', now: new Date('2026-11-05T12:00:00Z') });
  return {
    ...d,
    accounts: [],
    balanceHistory: [],
    transactions: [],
    transferLinks: [],
    budgets: [],
    goals: [],
    recurring: [],
    holdings: [],
    taxLots: [],
    activities: [],
    receipts: [],
    connections: [],
  };
}

describe('empty screens', () => {
  const sample = createSampleData({ today: '2026-11-05', now: new Date('2026-11-05T12:00:00Z') });

  beforeEach(async () => {
    await act(() => updateSettings({ ...DEFAULT_SETTINGS }));
    await act(() => setFinance(emptyData()));
  });
  afterAll(async () => {
    await act(() => setFinance(sample));
  });

  it('Accounts says there are none and points to Connectors', async () => {
    await render(inRoot(<AccountsScreen />));
    expect(screen.getByTestId('accounts-empty')).toBeTruthy();
    expect(screen.getByText('No accounts yet')).toBeTruthy();
    await fireEvent.press(screen.getByText('Open Connectors'));
    expect(screen.queryByTestId('accounts-empty')).toBeNull();
  });

  it('Transactions: none yet, and "Nothing matches" only for a search', async () => {
    await render(inRoot(<TransactionsScreen />));
    expect(screen.getByTestId('transactions-empty')).toBeTruthy();
    expect(screen.queryByTestId('transactions-no-match')).toBeNull();
    await fireEvent.changeText(screen.getByPlaceholderText(/Search/), 'coffee');
    expect(screen.getByTestId('transactions-no-match')).toBeTruthy();
  });

  it('Recurring shows one empty state instead of three empty headers', async () => {
    await render(inRoot(<RecurringScreen />));
    expect(screen.getByTestId('recurring-empty')).toBeTruthy();
    expect(screen.queryByText('Subscriptions')).toBeNull();
    expect(screen.queryByText('Bills')).toBeNull();
    expect(screen.queryByText('Income')).toBeNull();
  });

  it('Investments says there are no positions', async () => {
    await render(inRoot(<InvestmentsScreen />));
    expect(screen.getByTestId('positions-empty')).toBeTruthy();
  });

  it('Planning says there are no goals', async () => {
    await render(inRoot(<PlanningScreen />));
    expect(screen.getByTestId('goals-empty')).toBeTruthy();
  });

  it('Home: no "below last month" badge when both months are 0', async () => {
    await render(inRoot(<DashboardScreen />));
    expect(screen.queryByTestId('spending-vs-last-month')).toBeNull();
    expect(screen.getByTestId('spending-delta')).toHaveTextContent(
      'The same as at this point last month',
    );
  });

  it('Month in review: "the same as the month before" and no empty category list', async () => {
    await render(inRoot(<RecapScreen kind="monthly" />));
    expect(screen.getByTestId('recap-diff')).toHaveTextContent('The same as the month before');
    expect(screen.getByTestId('recap-no-categories')).toBeTruthy();
  });
});

describe('Home with spending', () => {
  beforeEach(async () => {
    await act(() => updateSettings({ ...DEFAULT_SETTINGS }));
    await act(() =>
      setFinance(createSampleData({ today: '2026-11-05', now: new Date('2026-11-05T12:00:00Z') })),
    );
  });

  it('keeps the badge and the amount when the months differ', async () => {
    await render(inRoot(<DashboardScreen />));
    expect(screen.getByTestId('spending-vs-last-month')).toBeTruthy();
    expect(screen.getByTestId('spending-delta')).toHaveTextContent(
      /(more|less) than the same point/,
    );
  });
});

describe('the sample-data banner on Home', () => {
  afterEach(async () => {
    await act(() => {
      setBackendConfigForTests({ url: '', token: '' });
      setBackendStatus({ mode: 'sample', loading: false, error: null });
    });
  });

  it('asks to set up the backend only when there is none', async () => {
    await act(() => setBackendConfigForTests({ url: '', token: '' }));
    await render(inRoot(<DashboardScreen />));
    expect(screen.getByTestId('sample-banner')).toHaveTextContent(/Set up the backend/);
  });

  it('says the Worker is loading, or could not be loaded, when one is set up', async () => {
    await act(() => {
      setBackendConfigForTests({ url: 'https://worker.example.test', token: 'invented' });
      setBackendStatus({ mode: 'sample', loading: true });
    });
    await render(inRoot(<DashboardScreen />));
    expect(screen.getByTestId('sample-banner')).toHaveTextContent(
      "Sample data while your Worker's data loads.",
    );
    await act(() => setBackendStatus({ loading: false, error: 'The API token is wrong.' }));
    expect(screen.getByTestId('sample-banner')).toHaveTextContent(/could not be loaded/);
    expect(screen.getByTestId('sample-banner')).not.toHaveTextContent(/Set up the backend/);
  });
});

describe('the look cards in Settings', () => {
  it('show each description in full', async () => {
    await render(inRoot(<AppearanceSection />));
    for (const look of ['midnight', 'warm', 'compact']) {
      expect(screen.getByTestId(`look-${look}-description`).props.numberOfLines).toBeUndefined();
    }
  });
});
