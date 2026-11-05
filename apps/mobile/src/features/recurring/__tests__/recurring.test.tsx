import { act, fireEvent, screen } from '@testing-library/react-native';
import { renderScreen } from '../../planning/__tests__/helpers';
import { DEFAULT_SETTINGS, addDays, todayLocal } from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import { updateSettings } from '../../../data/settingsStore';
import { getFinance, setFinance } from '../../../data/store';
import { RecurringScreen } from '../RecurringScreen';
import { setDecision, setRecurringStatus } from '../actions';

const find = (id: string) => getFinance().recurring.find((r) => r.id === id)!;

describe('Recurring', () => {
  beforeEach(async () => {
    const data = createSampleData();
    const today = todayLocal();
    // Netflix just went up; make sure it is due soon and the rest are in range.
    data.recurring = data.recurring.map((r) =>
      r.id === 'rec_netflix'
        ? {
            ...r,
            expectedAmount: -2_299,
            nextDueDate: addDays(today, 3),
            priceHistory: [
              { date: addDays(today, -62), amount: -1_799 },
              { date: addDays(today, -31), amount: -1_799 },
              { date: addDays(today, -1), amount: -2_299 },
            ],
          }
        : r,
    );
    await act(() => {
      setFinance(data);
      updateSettings({ ...DEFAULT_SETTINGS });
    });
  });

  it('warns about a price increase with the percent and yearly cost', async () => {
    await renderScreen(<RecurringScreen />);
    expect(screen.getByTestId('increase-rec_netflix').props.children).toContain('went up 28%');
  });

  it('lists upcoming charges in the next 30 days', async () => {
    await renderScreen(<RecurringScreen />);
    expect(screen.getByTestId(`upcoming-rec_netflix-${addDays(todayLocal(), 3)}`)).toBeTruthy();
    expect(screen.getByTestId('recurring-due-total')).toBeTruthy();
  });

  it('changes a keep / cancel / review decision', async () => {
    await renderScreen(<RecurringScreen />);
    await fireEvent.press(screen.getByTestId('recurring-rec_netflix'));
    await fireEvent.press(screen.getByLabelText('Keep'));
    expect(find('rec_netflix').decision).toBe('keep');
    await fireEvent.press(screen.getByLabelText('Cancel'));
    expect(find('rec_netflix').decision).toBe('cancel');
  });

  it('moves a cancelled subscription out of the active list', async () => {
    await renderScreen(<RecurringScreen />);
    await fireEvent.press(screen.getByTestId('recurring-rec_gym'));
    await fireEvent.press(screen.getByTestId('recurring-mark-cancelled'));
    expect(find('rec_gym').status).toBe('cancelled');
    expect(screen.getAllByText('Cancelled').length).toBeGreaterThan(0);
  });

  it('shows the monthly total in both currencies in Both mode', async () => {
    await act(() => updateSettings({ displayCurrencyMode: 'BOTH' }));
    await renderScreen(<RecurringScreen />);
    expect(screen.getAllByText(/₹/).length).toBeGreaterThan(0);
  });
});

describe('recurring actions', () => {
  it('sets and clears a decision', async () => {
    await act(() => setFinance(createSampleData()));
    await act(() => setDecision('rec_spotify', 'review'));
    expect(find('rec_spotify').decision).toBe('review');
    await act(() => setRecurringStatus('rec_spotify', 'cancelled'));
    expect(find('rec_spotify')).toMatchObject({ status: 'cancelled', decision: 'cancel' });
  });
});
