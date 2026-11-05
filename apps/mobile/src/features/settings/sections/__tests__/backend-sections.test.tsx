import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { DEFAULT_MONEY_POLICIES, DEFAULT_SETTINGS } from '@manaclaude/shared';
import { getSettings, updateSettings } from '../../../../data/settingsStore';
import { AiSection } from '../AiSection';
import { MoneyPoliciesSection } from '../MoneyPoliciesSection';

describe('AI and money policy settings', () => {
  beforeEach(async () => {
    await act(() => updateSettings({ ...DEFAULT_SETTINGS }));
  });

  it('turning AI off says what still works and hides the provider list', async () => {
    await render(<AiSection />);
    expect(screen.getByText('Workers AI')).toBeTruthy();
    await fireEvent(screen.getByTestId('switch-ai'), 'valueChange', false);
    expect(getSettings().aiEnabled).toBe(false);
    expect(screen.queryByText('Workers AI')).toBeNull();
    expect(screen.getByText(/nothing is sent to any AI/)).toBeTruthy();
  });

  it('shows Reset only after a policy changes, and Reset restores the defaults', async () => {
    await render(<MoneyPoliciesSection />);
    expect(screen.queryByTestId('reset-money-policies')).toBeNull();
    await act(() =>
      updateSettings({ moneyPolicies: { ...DEFAULT_MONEY_POLICIES, cardPayments: 'count' } }),
    );
    await fireEvent.press(screen.getByTestId('reset-money-policies'));
    expect(getSettings().moneyPolicies).toEqual(DEFAULT_MONEY_POLICIES);
  });
});
