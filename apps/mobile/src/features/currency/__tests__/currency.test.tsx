import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { DEFAULT_SETTINGS, MINUS, formatMoney } from '@manaclaude/shared';
import { getSettings, updateSettings } from '../../../data/settingsStore';
import { getFinance } from '../../../data/store';
import { Amount, DualAmount } from '../Amount';
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

describe('display currency, linked transfers and reports', () => {
  beforeEach(async () => {
    await act(() => updateSettings({ ...DEFAULT_SETTINGS }));
  });

  it('a linked cross-currency transfer converts with its own rate, not the market rate', async () => {
    const link = {
      id: 'tl',
      outTransactionId: 'a',
      inTransactionId: 'b',
      outAmount: -100_000,
      outCurrency: 'USD',
      inAmount: 8_700_000,
      inCurrency: 'INR',
      impliedRate: 87,
      status: 'confirmed',
      kind: 'transfer',
      matchScore: 1,
      matchedBy: 'user',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    } as const;
    await act(() => updateSettings({ displayCurrencyMode: 'INR' }));
    await render(<Amount amount={-100_000} currency="USD" link={link} />);
    expect(screen.getByText(formatMoney(-8_700_000, 'INR'))).toBeTruthy();
  });

  it('uses the rate on the transaction date for spending', async () => {
    const rates = getFinance().fxRates.filter((r) => r.quote === 'INR');
    const oldest = [...rates].sort((a, b) => a.date.localeCompare(b.date))[0]!;
    await act(() => updateSettings({ displayCurrencyMode: 'INR' }));
    await render(<Amount amount={10_000} currency="USD" date={oldest.date} />);
    expect(screen.getByText(formatMoney(Math.round(10_000 * oldest.rate), 'INR'))).toBeTruthy();
  });

  it('uses the latest rate for balances', async () => {
    await act(() => updateSettings({ displayCurrencyMode: 'INR' }));
    await render(<Amount amount={10_000} currency="USD" />);
    expect(screen.getByText(formatMoney(Math.round(10_000 * latestUsdInr()), 'INR'))).toBeTruthy();
  });

  it('shows a dual total with each currency computed on its own', async () => {
    await act(() => updateSettings({ displayCurrencyMode: 'BOTH' }));
    await render(<DualAmount main={12_345} sub={{ amount: 1_100_000, currency: 'INR' }} />);
    expect(screen.getByText('$123.45')).toBeTruthy();
    expect(screen.getByText('₹11,000.00')).toBeTruthy();
  });
});
