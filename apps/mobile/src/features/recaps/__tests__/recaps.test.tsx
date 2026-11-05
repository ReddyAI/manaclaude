import { act, fireEvent, screen } from '@testing-library/react-native';
import { renderScreen } from '../../planning/__tests__/helpers';
import { DEFAULT_SETTINGS, todayLocal, type Recap } from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import { updateSettings } from '../../../data/settingsStore';
import { getFinance, setFinance } from '../../../data/store';
import { RecapScreen } from '../RecapScreen';

describe('Recaps', () => {
  beforeEach(async () => {
    await act(() => {
      setFinance(createSampleData());
      updateSettings({ ...DEFAULT_SETTINGS });
    });
  });

  it('builds a weekly recap from the sample transactions', async () => {
    await renderScreen(<RecapScreen kind="weekly" />);
    expect(screen.getByTestId('recap-headline').props.children).toMatch(/You spent/);
    expect(screen.getByTestId('recap-spending')).toBeTruthy();
  });

  it('builds a month in review and switches month', async () => {
    await renderScreen(<RecapScreen kind="monthly" />);
    const current = screen.getByTestId('recap-headline').props.children;
    expect(current).toMatch(/You spent/);
    await fireEvent.press(screen.getByLabelText('October 2026'));
    const october = screen.getByTestId('recap-headline').props.children;
    expect(october).toMatch(/October 2026/);
    expect(october).not.toBe(current);
  });

  it('shows INR spending when the display currency is INR', async () => {
    await act(() => updateSettings({ displayCurrencyMode: 'INR' }));
    await renderScreen(<RecapScreen kind="weekly" />);
    expect(screen.getByTestId('recap-headline').props.children).toMatch(/₹/);
  });

  it('uses a recap stored by the backend job when it matches', async () => {
    const local = getFinance();
    const today = todayLocal();
    const start = new Date(`${today}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - 6);
    const stored: Recap = {
      id: 'recap_ai_1',
      kind: 'weekly',
      periodStart: start.toISOString().slice(0, 10),
      periodEnd: today,
      currency: 'USD',
      spending: 123_400,
      income: 0,
      previousSpending: 100_000,
      topCategories: [],
      biggestTransactions: [],
      netWorthChange: null,
      headline: 'AI says: quiet week.',
      highlights: [],
      source: 'ai',
      createdAt: new Date().toISOString(),
    };
    await act(() => setFinance({ ...local, recaps: [stored] }));
    await renderScreen(<RecapScreen kind="weekly" />);
    expect(screen.getByTestId('recap-headline').props.children).toBe('AI says: quiet week.');
  });
});
