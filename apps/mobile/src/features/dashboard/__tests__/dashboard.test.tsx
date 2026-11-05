import { act, render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { DEFAULT_SETTINGS } from '@manaclaude/shared';
import { updateSettings } from '../../../data/settingsStore';
import { DashboardScreen } from '../DashboardScreen';

jest.mock('expo-router', () => ({ router: { push: jest.fn(), navigate: jest.fn() } }));
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
