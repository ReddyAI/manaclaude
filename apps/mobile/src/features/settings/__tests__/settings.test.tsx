import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { DEFAULT_SETTINGS } from '@manaclaude/shared';
import { getSettings, updateSettings } from '../../../data/settingsStore';
import { SettingsScreen } from '../SettingsScreen';

describe('Settings', () => {
  beforeEach(async () => {
    await act(() => updateSettings({ ...DEFAULT_SETTINGS }));
  });

  it('switches the look', async () => {
    await render(<SettingsScreen />);
    await fireEvent.press(screen.getByTestId('look-compact'));
    expect(getSettings().look).toBe('compact');
    await fireEvent.press(screen.getByTestId('look-warm'));
    expect(getSettings().look).toBe('warm');
  });

  it('turns haptics and AI off', async () => {
    await render(<SettingsScreen />);
    await fireEvent.press(screen.getByTestId('switch-haptics'));
    await fireEvent.press(screen.getByTestId('switch-ai'));
    expect(getSettings().hapticsEnabled).toBe(false);
    expect(getSettings().aiEnabled).toBe(false);
  });

  it('starts with the default money policies from the brief', async () => {
    expect(getSettings().moneyPolicies).toEqual({
      transfers: 'exclude',
      cardPayments: 'exclude',
      investmentContributions: 'exclude',
      loanPrincipal: 'exclude',
      refunds: 'reduce_category',
      categoryFloor: 'none',
      pendingTransactions: 'include',
    });
  });
});
