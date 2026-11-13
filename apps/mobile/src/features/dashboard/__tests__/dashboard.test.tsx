import { act, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { DEFAULT_SETTINGS } from '@manaclaude/shared';
import { setBackendConfigForTests } from '../../../data/backend/config';
import { fakeBackend, json } from '../../../data/backend/__tests__/helpers';
import { updateSettings } from '../../../data/settingsStore';
import { resetAlertsForTests } from '../../alerts/alertsStore';
import { DashboardScreen } from '../DashboardScreen';

jest.mock('expo-router', () => ({ router: { push: jest.fn(), navigate: jest.fn() } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('../../../design/haptics', () => ({
  ...jest.requireActual('../../../design/haptics'),
  haptic: jest.fn(),
}));

/** The chart's scrubbing gesture needs the root view the app layout provides. */
const inRoot = (ui: ReactElement) => <GestureHandlerRootView>{ui}</GestureHandlerRootView>;

describe('dashboard layouts', () => {
  beforeEach(async () => {
    await act(() => updateSettings({ ...DEFAULT_SETTINGS }));
  });

  it('widget grid: net worth, budget, review, upcoming and recent', async () => {
    await render(inRoot(<DashboardScreen />));
    expect(screen.getByTestId('net-worth')).toBeTruthy();
    expect(screen.getByText('Budget')).toBeTruthy();
    expect(screen.getByText('Coming up')).toBeTruthy();
    expect(screen.getByText('Recent')).toBeTruthy();
    expect(screen.getByText(/transactions to review/)).toBeTruthy();
    expect(screen.queryByText('Safe to spend this month')).toBeNull();
    expect(screen.getByTestId('cash-quick-add')).toBeTruthy();
  });

  it('safe to spend: one number and a spending chart', async () => {
    await act(() => updateSettings({ dashboardLayout: 'safe_to_spend' }));
    await render(inRoot(<DashboardScreen />));
    expect(screen.getByText('Safe to spend this month')).toBeTruthy();
    expect(screen.getByTestId('spending-chart')).toBeTruthy();
    expect(screen.queryByTestId('net-worth')).toBeNull();
    expect(screen.queryByText('Coming up')).toBeNull();
  });

  it('shows the currency chip in both layouts', async () => {
    const view = await render(inRoot(<DashboardScreen />));
    expect(screen.getByTestId('currency-chip')).toBeTruthy();
    await act(() => updateSettings({ dashboardLayout: 'safe_to_spend' }));
    await view.rerender(inRoot(<DashboardScreen />));
    expect(screen.getByTestId('currency-chip')).toBeTruthy();
  });
});

describe('the ways to the alerts and Ask AI', () => {
  afterEach(() => {
    setBackendConfigForTests({ url: '', token: '' });
    resetAlertsForTests();
  });

  it('is on Home in both layouts when a backend is set, and absent without one', async () => {
    const view = await render(inRoot(<DashboardScreen />));
    expect(screen.queryByTestId('alerts-entry')).toBeNull();
    expect(screen.queryByTestId('ask-entry')).toBeNull();
    await view.unmount();

    const alert = {
      id: 'alr_1',
      type: 'unusual',
      transactionId: null,
      recurringId: null,
      message: 'Demo charge is far above the usual.',
      amount: 310_00,
      currency: 'USD',
      createdAt: '2026-11-04T06:30:00.000Z',
      dismissedAt: null,
    };
    const backend = fakeBackend({ 'GET /v1/alerts': () => json(200, { alerts: [alert] }) });
    try {
      setBackendConfigForTests({ url: 'https://api.demo.test', token: 'demo-token' });
      const grid = await render(inRoot(<DashboardScreen />));
      await waitFor(() => expect(screen.getByText('1 alert')).toBeTruthy());
      expect(screen.getByTestId('ask-entry')).toBeTruthy();
      await grid.unmount();
      await act(() => updateSettings({ dashboardLayout: 'safe_to_spend' }));
      await render(inRoot(<DashboardScreen />));
      await waitFor(() => expect(screen.getByText('1 alert')).toBeTruthy());
      expect(screen.getByText('Safe to spend this month')).toBeTruthy();
      expect(screen.getByTestId('ask-entry')).toBeTruthy();
    } finally {
      backend.restore();
    }
  });
});
