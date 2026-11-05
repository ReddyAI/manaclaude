import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { DEFAULT_SETTINGS, MINUS, formatMoney } from '@manaclaude/shared';
import { getSettings, updateSettings } from '../../../data/settingsStore';
import { getFinance } from '../../../data/store';
import { Amount } from '../Amount';
import { CurrencyChip } from '../CurrencyChip';

/** Sample data's latest USD to INR rate, the one balances use. */
function latestUsdInr(): number {
  const latest = getFinance().fxRates.filter(
    (r) => r.quote === 'INR' && r.source === 'openexchangerates',
  );
  const rate = latest[latest.length - 1]?.rate;
  if (rate === undefined) throw new Error('sample data has no latest INR rate');
  return rate;
}

describe('display currency', () => {
  beforeEach(async () => {
    await act(() => updateSettings({ ...DEFAULT_SETTINGS }));
  });

  it('cycles USD, INR, Both, Native when the chip is tapped', async () => {
    await render(<CurrencyChip />);
    const chip = screen.getByTestId('currency-chip');
    const seen = [getSettings().displayCurrencyMode];
    for (let i = 0; i < 4; i += 1) {
      await fireEvent.press(chip);
      seen.push(getSettings().displayCurrencyMode);
    }
    expect(seen).toEqual(['USD', 'INR', 'BOTH', 'NATIVE', 'USD']);
  });

  it('converts an INR balance to USD with the latest rate', async () => {
    await render(<Amount amount={8_840_000} currency="INR" />);
    const usd = Math.round(8_840_000 / latestUsdInr());
    expect(screen.getByText(formatMoney(usd, 'USD'))).toBeTruthy();
  });

  it('shows USD large with INR underneath in Both mode', async () => {
    await act(() => updateSettings({ displayCurrencyMode: 'BOTH' }));
    await render(<Amount amount={-10_000} currency="USD" />);
    expect(screen.getByText(`${MINUS}$100.00`)).toBeTruthy();
    expect(screen.getByText(formatMoney(-Math.round(10_000 * latestUsdInr()), 'INR'))).toBeTruthy();
  });

  it('keeps each amount in its own currency in Native mode', async () => {
    await act(() => updateSettings({ displayCurrencyMode: 'NATIVE' }));
    await render(<Amount amount={12_345_678} currency="INR" />);
    expect(screen.getByText('₹1,23,456.78')).toBeTruthy();
  });
});
