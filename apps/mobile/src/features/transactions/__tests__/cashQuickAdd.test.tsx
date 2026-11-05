import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { DEFAULT_SETTINGS, todayLocal } from '@manaclaude/shared';
import { updateSettings } from '../../../data/settingsStore';
import { getFinance } from '../../../data/store';
import {
  padAmount,
  padDisplay,
  padReduce,
  pickCashAccount,
  quickAddCategories,
  quickAddCurrency,
  type PadKey,
} from '../cash';
import { CashQuickAddSheet } from '../CashQuickAdd';
import { resetFinance } from './helpers';

jest.mock('../../../design/haptics', () => ({
  ...jest.requireActual('../../../design/haptics'),
  haptic: jest.fn(),
}));

function type(keys: PadKey[], currency: 'USD' | 'INR' = 'USD'): string {
  return keys.reduce((value, key) => padReduce(value, key, currency), '');
}

describe('number pad', () => {
  it('types dollars and cents, and stops at two decimals', () => {
    expect(type(['1', '2', '.', '5'])).toBe('12.5');
    expect(type(['1', '2', '.', '5', '0', '9'])).toBe('12.50');
    expect(padAmount('12.5', 'USD')).toBe(1_250);
    expect(padAmount('12.50', 'USD')).toBe(1_250);
  });

  it('has no leading zeros and one decimal point', () => {
    expect(type(['0', '0', '5'])).toBe('5');
    expect(type(['.', '5'])).toBe('0.5');
    expect(type(['1', '.', '.', '2'])).toBe('1.2');
    expect(padAmount('0.05', 'USD')).toBe(5);
  });

  it('deletes the last key and ignores huge amounts', () => {
    expect(type(['1', '2', '3', 'back'])).toBe('12');
    expect(type(['back'])).toBe('');
    expect(type(Array<PadKey>(12).fill('9')).length).toBe(9);
  });

  it('shows grouped digits in the right currency', () => {
    expect(padDisplay('1234.5', 'USD')).toBe('$1,234.5');
    expect(padDisplay('', 'USD')).toBe('$0');
    expect(padDisplay('123456', 'INR')).toBe('₹1,23,456');
  });
});

describe('cash accounts', () => {
  it('uses the header currency, and the main currency for Both and Native', () => {
    expect(quickAddCurrency('USD', 'USD')).toBe('USD');
    expect(quickAddCurrency('INR', 'USD')).toBe('INR');
    expect(quickAddCurrency('BOTH', 'USD')).toBe('USD');
    expect(quickAddCurrency('NATIVE', 'INR')).toBe('INR');
  });

  it('picks the default cash account for the currency', () => {
    const { accounts } = resetFinance();
    expect(pickCashAccount(accounts, 'USD')?.id).toBe('acc_cash_usd');
    expect(pickCashAccount(accounts, 'INR')?.id).toBe('acc_cash_inr');
    expect(pickCashAccount(accounts, 'EUR')).toBeNull();
  });

  it('lists expense categories for spending and income categories for money received', () => {
    const data = resetFinance();
    const today = todayLocal();
    expect(quickAddCategories(data, 'expense', today).every((c) => c.kind === 'expense')).toBe(
      true,
    );
    expect(quickAddCategories(data, 'income', today).every((c) => c.kind === 'income')).toBe(true);
  });
});

describe('cash quick-add sheet', () => {
  beforeEach(async () => {
    resetFinance();
    await act(() => updateSettings({ ...DEFAULT_SETTINGS }));
  });

  async function pressKeys(...keys: string[]) {
    for (const key of keys) await fireEvent.press(screen.getByTestId(`pad-${key}`));
  }

  it('number pad first, then category, then a transaction in the USD cash account', async () => {
    const before = getFinance();
    const cashBefore = before.accounts.find((a) => a.id === 'acc_cash_usd')!;
    const onClose = jest.fn();
    await render(<CashQuickAddSheet visible onClose={onClose} />);

    expect(screen.getByTestId('cash-amount').props.children).toBe('$0');
    expect(screen.getByTestId('cash-next').props.accessibilityState?.disabled).toBe(true);
    await pressKeys('1', '2', '.', '5');
    expect(screen.getByTestId('cash-amount').props.children).toBe('$12.5');

    await fireEvent.press(screen.getByTestId('cash-next'));
    expect(screen.queryByTestId('pad-1')).toBeNull();
    await fireEvent.press(screen.getByTestId('cash-category-cat_coffee'));

    const after = getFinance();
    const added = after.transactions.find((t) => !before.transactions.some((b) => b.id === t.id));
    expect(added).toMatchObject({
      accountId: 'acc_cash_usd',
      amount: -1_250,
      currency: 'USD',
      categoryId: 'cat_coffee',
      reviewed: true,
      source: 'manual',
      kind: 'regular',
      date: todayLocal(),
    });
    expect(after.accounts.find((a) => a.id === 'acc_cash_usd')?.balance).toBe(
      cashBefore.balance - 1_250,
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('goes to the INR cash account when the display currency is INR', async () => {
    await act(() => updateSettings({ displayCurrencyMode: 'INR' }));
    const before = getFinance();
    await render(<CashQuickAddSheet visible onClose={() => {}} />);
    expect(screen.getByTestId('cash-amount').props.children).toBe('₹0');
    await pressKeys('4', '5', '0');
    await fireEvent.press(screen.getByTestId('cash-next'));
    await fireEvent.press(screen.getByTestId('cash-category-cat_dining'));
    const added = getFinance().transactions.find(
      (t) => !before.transactions.some((b) => b.id === t.id),
    );
    expect(added).toMatchObject({ accountId: 'acc_cash_inr', amount: -45_000, currency: 'INR' });
  });

  it('records money received as a positive amount', async () => {
    const before = getFinance();
    await render(<CashQuickAddSheet visible onClose={() => {}} />);
    await fireEvent.press(screen.getByLabelText('Received'));
    await pressKeys('2', '0');
    await fireEvent.press(screen.getByTestId('cash-next'));
    const incomeCategory = quickAddCategories(getFinance(), 'income', todayLocal())[0]!;
    await fireEvent.press(screen.getByTestId(`cash-category-${incomeCategory.id}`));
    const added = getFinance().transactions.find(
      (t) => !before.transactions.some((b) => b.id === t.id),
    );
    expect(added?.amount).toBe(2_000);
  });

  it('explains when there is no cash account in the currency', async () => {
    await act(() => updateSettings({ displayCurrencyMode: 'NATIVE', primaryCurrency: 'EUR' }));
    await render(<CashQuickAddSheet visible onClose={() => {}} />);
    expect(screen.getByText('No EUR cash account')).toBeTruthy();
  });
});
