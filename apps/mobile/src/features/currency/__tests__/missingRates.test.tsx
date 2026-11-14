import { act, fireEvent, screen } from '@testing-library/react-native';
import {
  buildTreatmentContext,
  DEFAULT_SETTINGS,
  summarizeSpending,
  type Account,
  type FinanceDataset,
  type RecurringItem,
  type Transaction,
} from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import { transactionsWithoutRate } from '../../../data/metrics';
import { useLookups } from '../../../data/selectors';
import { updateSettings } from '../../../data/settingsStore';
import { setFinance } from '../../../data/store';
import { BudgetsScreen } from '../../budgets/BudgetsScreen';
import { DashboardScreen } from '../../dashboard/DashboardScreen';
import { renderScreen } from '../../planning/__tests__/helpers';
import { RecapScreen } from '../../recaps/RecapScreen';
import { RecurringScreen } from '../../recurring/RecurringScreen';
import { TransactionsTable } from '../../transactions/TransactionsTable';
import {
  budgetsNoRateText,
  selectedNoRateText,
  skippedItemsText,
  skippedTransactionsText,
} from '../missingRates';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn() },
  useLocalSearchParams: () => ({}),
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('../../../design/haptics', () => ({
  ...jest.requireActual('../../../design/haptics'),
  haptic: jest.fn(),
}));

// All data is invented. The sample rates cover USD, INR and EUR, not CHF.
// The test clock reads 5 November 2026.
const base = createSampleData();
const cashUsd = base.accounts.find((a) => a.id === 'acc_cash_usd')!;
const chfWallet: Account = {
  ...cashUsd,
  id: 'acc_cash_chf',
  name: 'Zurich wallet',
  currency: 'CHF',
  balance: 300_00,
  isDefaultCash: true,
};
const spend = base.transactions.find(
  (t) => t.amount < 0 && t.kind === 'regular' && !t.excluded && t.date.startsWith('2026-11'),
)!;
const chfTxn = (id: string, name: string, amount: number, over: Partial<Transaction> = {}) =>
  ({
    ...spend,
    id,
    name,
    rawName: name,
    accountId: chfWallet.id,
    currency: 'CHF',
    amount,
    originalAmount: amount,
    originalCurrency: 'CHF',
    date: '2026-11-03',
    transferLinkId: null,
    splitParentId: null,
    isSplitParent: false,
    receiptId: null,
    ...over,
  }) as Transaction;
const migros = chfTxn('txn_chf_migros', 'Migros', -42_50);
const sbb = chfTxn('txn_chf_sbb', 'SBB ticket', -18_00);
const leftOut = chfTxn('txn_chf_left', 'Left out', -9_00, { excluded: true });
const withChf = (extra: Partial<FinanceDataset> = {}): FinanceDataset => ({
  ...base,
  accounts: [...base.accounts, chfWallet],
  transactions: [...base.transactions, migros, sbb, leftOut],
  ...extra,
});

describe('spending totals with no exchange rate', () => {
  it('list exactly the transactions the summary skips', () => {
    const d = withChf();
    const ctx = buildTreatmentContext(
      DEFAULT_SETTINGS.moneyPolicies,
      d.categories,
      d.transferLinks,
    );
    const range = { from: '2026-11-01', to: '2026-11-05' };
    const skipped = transactionsWithoutRate(d, ctx, range.from, range.to, 'USD');
    const summary = summarizeSpending(d.transactions, ctx, {
      ...range,
      currency: 'USD',
      rates: d.fxRates,
    });
    expect(skipped.map((t) => t.id)).toEqual(['txn_chf_migros', 'txn_chf_sbb']);
    expect(summary.missingRate).toBe(skipped.length);
    expect(transactionsWithoutRate(base, ctx, range.from, range.to, 'USD')).toEqual([]);
    expect(transactionsWithoutRate(d, ctx, '2026-11-04', '2026-11-05', 'USD')).toEqual([]);
    expect(transactionsWithoutRate(d, ctx, '2026-11-01', '2026-11-02', 'USD')).toEqual([]);
  });

  it('are named in plain words', () => {
    expect(skippedTransactionsText([migros], 'USD')).toBe(
      'Leaves out "Migros" (CHF 42.50, Nov 3): there is no CHF to USD exchange rate yet. Refresh rates in Settings, Exchange rates.',
    );
    expect(skippedTransactionsText([migros, sbb], 'USD')).toBe(
      'Leaves out 2 transactions in CHF with no exchange rate to USD: "Migros", "SBB ticket". Refresh rates in Settings, Exchange rates.',
    );
    const many = ['A', 'B', 'C', 'D', 'E'].map((n) => chfTxn(`t${n}`, n, -100));
    expect(skippedTransactionsText(many, 'USD')).toMatch(/: "A", "B", "C" and 2 more\./);
    expect(skippedTransactionsText([], 'USD')).toBeNull();
    expect(skippedItemsText([{ name: 'Rail pass', currency: 'CHF' }], 'USD')).toBe(
      'Leaves out "Rail pass" (CHF): there is no CHF to USD exchange rate yet. Refresh rates in Settings, Exchange rates.',
    );
    expect(budgetsNoRateText([{ name: 'Travel', currency: 'CHF' }], 'USD')).toBe(
      'The "Travel" budget is in CHF, and there is no CHF to USD exchange rate yet, so it counts as 0 here. Refresh rates in Settings, Exchange rates.',
    );
    expect(selectedNoRateText(0, 'USD')).toBeNull();
    expect(selectedNoRateText(2, 'USD')).toBe('2 are not in the total: no exchange rate to USD.');
  });
});

describe('screens name what a spending total leaves out', () => {
  beforeEach(async () => {
    await act(async () => updateSettings({ ...DEFAULT_SETTINGS }));
  });

  it('Home, on the spending card', async () => {
    await act(async () => setFinance(withChf()));
    await renderScreen(<DashboardScreen />);
    expect(screen.getByTestId('spending-no-rate').props.children).toBe(
      skippedTransactionsText([migros, sbb], 'USD'),
    );
  });

  it('Budgets, for the month and for a budget set in CHF', async () => {
    const month = base.budgets.find((b) => b.month === '2026-11')!;
    const travel = base.categories.find(
      (c) =>
        c.kind === 'expense' &&
        !base.budgets.some((b) => b.month === '2026-11' && b.categoryId === c.id),
    )!;
    const chfBudget = {
      ...month,
      id: 'bud_chf',
      categoryId: travel.id,
      currency: 'CHF',
      amount: 200_00,
    };
    await act(async () => setFinance(withChf({ budgets: [...base.budgets, chfBudget] })));
    await renderScreen(<BudgetsScreen />);
    expect(screen.getByTestId('budget-spending-no-rate').props.children).toBe(
      skippedTransactionsText([migros, sbb], 'USD'),
    );
    expect(screen.getByTestId('budget-amount-no-rate').props.children).toBe(
      budgetsNoRateText([{ name: travel.name, currency: 'CHF' }], 'USD'),
    );
  });

  it('the monthly recap', async () => {
    await act(async () => setFinance(withChf()));
    await renderScreen(<RecapScreen kind="monthly" />);
    expect(screen.getByTestId('recap-no-rate').props.children).toBe(
      skippedTransactionsText([migros, sbb], 'USD'),
    );
  });

  it('Recurring, for a bill in CHF', async () => {
    const bill = base.recurring.find((r) => r.status === 'active' && r.kind === 'bill')!;
    const rail: RecurringItem = { ...bill, id: 'rec_chf', name: 'Rail pass', currency: 'CHF' };
    const income: RecurringItem = {
      ...base.recurring.find((r) => r.kind === 'income')!,
      id: 'rec_chf_income',
      currency: 'CHF',
      status: 'active',
    };
    await act(async () => setFinance({ ...base, recurring: [...base.recurring, rail, income] }));
    await renderScreen(<RecurringScreen />);
    expect(screen.getByTestId('recurring-no-rate').props.children).toBe(
      skippedItemsText([rail], 'USD'),
    );
  });

  it('the Transactions table, for selected rows', async () => {
    const d = withChf();
    await act(async () => setFinance(d));
    function Table() {
      const lookups = useLookups();
      return (
        <TransactionsTable transactions={[migros, spend]} lookups={lookups} onOpen={() => {}} />
      );
    }
    await renderScreen(<Table />);
    await fireEvent.press(screen.getByLabelText('Select all'));
    expect(screen.getByTestId('table-selected').props.children).toBe(
      '2 selected. 1 is not in the total: no exchange rate to USD.',
    );
    await fireEvent.press(screen.getByLabelText(`Select ${'Migros'}`));
    expect(screen.getByTestId('table-selected').props.children).toBe('1 selected');
  });

  it('nothing when every rate is there', async () => {
    await act(async () => setFinance(createSampleData()));
    const home = await renderScreen(<DashboardScreen />);
    expect(screen.queryByTestId('spending-no-rate')).toBeNull();
    await home.unmount();
    const budgets = await renderScreen(<BudgetsScreen />);
    expect(screen.queryByTestId('budget-spending-no-rate')).toBeNull();
    expect(screen.queryByTestId('budget-amount-no-rate')).toBeNull();
    await budgets.unmount();
    const recap = await renderScreen(<RecapScreen kind="monthly" />);
    expect(screen.queryByTestId('recap-no-rate')).toBeNull();
    await recap.unmount();
    await renderScreen(<RecurringScreen />);
    expect(screen.queryByTestId('recurring-no-rate')).toBeNull();
  });
});
