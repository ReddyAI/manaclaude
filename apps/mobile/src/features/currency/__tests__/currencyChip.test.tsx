import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { DEFAULT_SETTINGS, formatRate } from '@manaclaude/shared';
import { getSettings, updateSettings } from '../../../data/settingsStore';
import { getFinance } from '../../../data/store';
import { haptic } from '../../../design/haptics';
import { CurrencyChip } from '../CurrencyChip';

jest.mock('../../../design/haptics', () => ({
  ...jest.requireActual('../../../design/haptics'),
  haptic: jest.fn(),
}));

describe('currency chip', () => {
  beforeEach(async () => {
    await act(() => updateSettings({ ...DEFAULT_SETTINGS }));
    (haptic as jest.Mock).mockClear();
  });

  it('names the two currencies in Both mode', async () => {
    await act(() => updateSettings({ displayCurrencyMode: 'BOTH' }));
    await render(<CurrencyChip />);
    expect(screen.getByText('USD + INR')).toBeTruthy();
  });

  it('long-press shows the current rate and when it was fetched', async () => {
    await render(<CurrencyChip />);
    expect(screen.queryByTestId('rate-sheet')).toBeNull();
    await fireEvent(screen.getByTestId('currency-chip'), 'longPress');
    expect(haptic).toHaveBeenCalledWith('longPress');

    const latest = getFinance()
      .fxRates.filter((r) => r.base === 'USD' && r.quote === 'INR')
      .sort((a, b) => b.asOf.localeCompare(a.asOf))[0]!;
    expect(screen.getByTestId('rate-value').props.children).toBe(
      formatRate(latest.rate, 'USD', 'INR'),
    );
    const fetched = screen.getByTestId('rate-fetched').props.children as string;
    expect(fetched).toMatch(/^Fetched /);
    expect(fetched).toMatch(/Open Exchange Rates|ECB via Frankfurter/);
    // A long-press does not change the mode.
    expect(getSettings().displayCurrencyMode).toBe('USD');
  });

  it('lets the sheet pick a mode directly', async () => {
    await render(<CurrencyChip />);
    await fireEvent(screen.getByTestId('currency-chip'), 'longPress');
    await fireEvent.press(screen.getByLabelText('Native'));
    expect(getSettings().displayCurrencyMode).toBe('NATIVE');
  });
});
