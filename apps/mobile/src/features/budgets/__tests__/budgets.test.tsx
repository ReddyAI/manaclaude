import { act, fireEvent, screen } from '@testing-library/react-native';
import { renderScreen } from '../../planning/__tests__/helpers';
import {
  DEFAULT_SETTINGS,
  addMonthsToMonth,
  monthOf,
  todayLocal,
  type FinanceDataset,
} from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import { updateSettings } from '../../../data/settingsStore';
import { getFinance, setFinance } from '../../../data/store';
import { BudgetsScreen } from '../BudgetsScreen';
import { copyBudgetsFromPreviousMonth, removeBudget, saveBudget } from '../actions';

const thisMonth = monthOf(todayLocal());
const lineOf = (d: FinanceDataset, categoryId: string, month = thisMonth) =>
  d.budgets.find((b) => b.categoryId === categoryId && b.month === month);

describe('Budgets', () => {
  beforeEach(async () => {
    await act(() => {
      setFinance(createSampleData());
      updateSettings({ ...DEFAULT_SETTINGS });
    });
  });

  it('lists budget lines grouped by category group', async () => {
    await renderScreen(<BudgetsScreen />);
    expect(screen.getByTestId('budget-cat_groceries')).toBeTruthy();
    expect(screen.getByTestId('budget-cat_rent')).toBeTruthy();
    expect(screen.getByTestId('budget-left')).toBeTruthy();
  });

  it('edits the amount and rollover of a line', async () => {
    await renderScreen(<BudgetsScreen />);
    await fireEvent.press(screen.getByTestId('budget-cat_dining'));
    await fireEvent.changeText(screen.getByTestId('budget-amount-input'), '525.50');
    await fireEvent.press(screen.getByTestId('budget-rollover-switch'));
    await fireEvent.press(screen.getByTestId('budget-save'));
    const line = lineOf(getFinance(), 'cat_dining');
    expect(line?.amount).toBe(52_550);
    expect(line?.rollover).toBe(true);
  });

  it('refuses an invalid amount', async () => {
    await renderScreen(<BudgetsScreen />);
    await fireEvent.press(screen.getByTestId('budget-cat_dining'));
    await fireEvent.changeText(screen.getByTestId('budget-amount-input'), 'abc');
    await fireEvent.press(screen.getByTestId('budget-save'));
    expect(lineOf(getFinance(), 'cat_dining')?.amount).toBe(40_000);
  });

  it('removes a line', async () => {
    await renderScreen(<BudgetsScreen />);
    await fireEvent.press(screen.getByTestId('budget-cat_coffee'));
    await fireEvent.press(screen.getByTestId('budget-remove'));
    expect(lineOf(getFinance(), 'cat_coffee')).toBeUndefined();
  });

  it('groups by Flex type when Flex mode is on', async () => {
    await act(() => updateSettings({ flexBudgeting: true }));
    await renderScreen(<BudgetsScreen />);
    expect(screen.getByTestId('budget-group-fixed')).toBeTruthy();
    expect(screen.getByTestId('budget-group-flexible')).toBeTruthy();
    expect(screen.getByTestId('budget-group-non_monthly')).toBeTruthy();
  });

  it('shows the Spending Plan: income minus bills and savings', async () => {
    await renderScreen(<BudgetsScreen />);
    await fireEvent.press(screen.getByLabelText('Spending plan'));
    expect(screen.getByTestId('spending-plan')).toBeTruthy();
    expect(screen.getByTestId('plan-income')).toBeTruthy();
    expect(screen.getByTestId('plan-bills')).toBeTruthy();
    expect(screen.getByTestId('plan-savings')).toBeTruthy();
    expect(screen.getByTestId('plan-left')).toBeTruthy();
    expect(screen.getByTestId('plan-remaining')).toBeTruthy();
  });

  it('offers to copy last month into an empty next month', async () => {
    await renderScreen(<BudgetsScreen />);
    await fireEvent.press(screen.getByLabelText('Next month'));
    expect(screen.getByText(/No budgets for/)).toBeTruthy();
    await fireEvent.press(screen.getByText("Copy last month's budgets"));
    const next = addMonthsToMonth(thisMonth, 1);
    expect(lineOf(getFinance(), 'cat_rent', next)).toBeTruthy();
    expect(screen.getByTestId('budget-cat_rent')).toBeTruthy();
  });

  it('shows the INR total under the USD one in Both mode', async () => {
    await act(() => updateSettings({ displayCurrencyMode: 'BOTH' }));
    await renderScreen(<BudgetsScreen />);
    expect(screen.getByTestId('budget-left')).toBeTruthy();
    expect(screen.getAllByText(/₹/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/\$/).length).toBeGreaterThan(0);
  });
});

describe('budget actions', () => {
  beforeEach(async () => {
    await act(() => setFinance(createSampleData()));
  });

  it('can apply a change to later months', async () => {
    const earlier = addMonthsToMonth(thisMonth, -2);
    await act(() =>
      saveBudget({
        categoryId: 'cat_dining',
        month: earlier,
        amount: 99_900,
        currency: 'USD',
        rollover: false,
        flexType: 'flexible',
        applyToLaterMonths: true,
      }),
    );
    expect(lineOf(getFinance(), 'cat_dining', thisMonth)?.amount).toBe(99_900);
    expect(lineOf(getFinance(), 'cat_dining', addMonthsToMonth(thisMonth, -3))?.amount).toBe(
      40_000,
    );
  });

  it('adds a new line and keeps existing lines when copying a month', async () => {
    const next = addMonthsToMonth(thisMonth, 1);
    await act(() =>
      saveBudget({
        categoryId: 'cat_pets',
        month: next,
        amount: 5_000,
        currency: 'USD',
        rollover: false,
        flexType: null,
      }),
    );
    let copied = 0;
    await act(() => {
      copied = copyBudgetsFromPreviousMonth(next);
    });
    expect(copied).toBeGreaterThan(10);
    expect(lineOf(getFinance(), 'cat_pets', next)?.amount).toBe(5_000);
    await act(() => removeBudget(next, 'cat_pets'));
    expect(lineOf(getFinance(), 'cat_pets', next)).toBeUndefined();
  });
});
