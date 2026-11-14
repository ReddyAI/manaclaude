import { act, fireEvent, screen } from '@testing-library/react-native';
import {
  DEFAULT_PLANNING,
  DEFAULT_SETTINGS,
  type FinanceDataset,
  type RecurringItem,
} from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import { updateSettings } from '../../../data/settingsStore';
import { setFinance } from '../../../data/store';
import { BudgetsScreen } from '../../budgets/BudgetsScreen';
import { InvestmentsScreen } from '../../networth/InvestmentsScreen';
import { renderScreen } from '../../planning/__tests__/helpers';
import { billNoRateText, savingsNoRateText, skippedItemsText } from '../missingRates';

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

/**
 * Block O: the Spending plan and Investments name what their totals leave out
 * for want of an exchange rate. All data is invented; the sample rates cover
 * USD, INR and EUR, not CHF. Numbers are unchanged.
 */

const base = createSampleData();
const someBill = base.recurring.find((r) => r.status === 'active' && r.kind === 'bill')!;
const chfBill: RecurringItem = {
  ...someBill,
  id: 'rec_chf_gym',
  name: 'Zurich gym',
  currency: 'CHF',
  expectedAmount: -60_00,
  categoryId: null,
};
const withChfBill = (): FinanceDataset => ({ ...base, recurring: [...base.recurring, chfBill] });

/** VTI held, sold and paid out in CHF instead of USD. */
const vtiInChf = (): FinanceDataset => ({
  ...base,
  holdings: base.holdings.map((h) => (h.securityId === 'sec_vti' ? { ...h, currency: 'CHF' } : h)),
  taxLots: base.taxLots.map((l) =>
    base.holdings.some((h) => h.id === l.holdingId && h.securityId === 'sec_vti')
      ? { ...l, currency: 'CHF' }
      : l,
  ),
  activities: base.activities.map((a) =>
    a.securityId === 'sec_vti' ? { ...a, currency: 'CHF' } : a,
  ),
});

const textOf = (id: string) => String(screen.getByTestId(id).props.children);

async function openPlan() {
  await renderScreen(<BudgetsScreen />);
  await fireEvent.press(screen.getByText('Spending plan'));
}

beforeEach(async () => {
  await act(() => {
    setFinance(createSampleData());
    updateSettings({ ...DEFAULT_SETTINGS });
  });
});

describe('wording', () => {
  it('names holdings, savings and one bill in plain words', () => {
    expect(skippedItemsText([{ name: 'VTI', currency: 'CHF' }], 'USD', 'holdings')).toBe(
      'Leaves out "VTI" (CHF): there is no CHF to USD exchange rate yet. Refresh rates in Settings, Exchange rates.',
    );
    expect(
      skippedItemsText(
        [
          { name: 'VTI', currency: 'CHF' },
          { name: 'NESN', currency: 'CHF' },
        ],
        'USD',
        'holdings',
      ),
    ).toMatch(/^Leaves out 2 holdings in CHF with no exchange rate to USD: "VTI", "NESN"\./);
    // The default noun is unchanged for bills and income.
    expect(
      skippedItemsText(
        [
          { name: 'A', currency: 'CHF' },
          { name: 'B', currency: 'CHF' },
        ],
        'USD',
      ),
    ).toMatch(/^Leaves out 2 items in CHF/);
    expect(savingsNoRateText('CHF', 'USD')).toMatch(
      /^Savings is set in CHF, and there is no CHF to USD exchange rate yet, so it counts as 0 here\./,
    );
    expect(billNoRateText('CHF', 'USD')).toBe('No CHF to USD rate yet, so it is not in the plan');
  });
});

describe('Spending plan', () => {
  it('names a bill with no rate, under the totals and on its row', async () => {
    await act(() => setFinance(withChfBill()));
    await openPlan();
    expect(textOf('plan-items-no-rate')).toMatch(
      /^Leaves out "Zurich gym" \(CHF\): there is no CHF to USD exchange rate yet/,
    );
    const row = screen.getByTestId('plan-bill-rec_chf_gym');
    expect(screen.getAllByText(/No CHF to USD rate yet, so it is not in the plan/)).toHaveLength(1);
    expect(row).toBeTruthy();
    // Other bills keep their plain subtitle.
    expect(screen.getByTestId(`plan-bill-${someBill.id}`)).toBeTruthy();
    expect(screen.queryByTestId('plan-savings-no-rate')).toBeNull();
  });

  it('names an income item with no rate too', async () => {
    const pay = base.recurring.find((r) => r.status === 'active' && r.kind === 'income')!;
    await act(() =>
      setFinance({
        ...base,
        recurring: [
          ...base.recurring,
          { ...pay, id: 'rec_chf_pay', name: 'Basel consulting', currency: 'CHF' },
        ],
      }),
    );
    await openPlan();
    expect(textOf('plan-items-no-rate')).toMatch(/"Basel consulting" \(CHF\)/);
  });

  it('leaves out paused items: they are not in the plan anyway', async () => {
    await act(() =>
      setFinance({ ...base, recurring: [...base.recurring, { ...chfBill, status: 'paused' }] }),
    );
    await openPlan();
    expect(screen.queryByTestId('plan-items-no-rate')).toBeNull();
  });

  it('says savings in a currency with no rate counts as 0', async () => {
    await act(() =>
      updateSettings({
        planning: { ...DEFAULT_PLANNING, currency: 'CHF', monthlyContribution: 500_00 },
      }),
    );
    await openPlan();
    expect(textOf('plan-savings-no-rate')).toMatch(/^Savings is set in CHF/);
  });

  it('says nothing about savings of 0', async () => {
    await act(() =>
      updateSettings({
        planning: { ...DEFAULT_PLANNING, currency: 'CHF', monthlyContribution: 0 },
      }),
    );
    await openPlan();
    expect(screen.queryByTestId('plan-savings-no-rate')).toBeNull();
  });

  it('nothing when every rate is there', async () => {
    await openPlan();
    expect(screen.getByTestId('spending-plan')).toBeTruthy();
    expect(screen.queryByTestId('plan-items-no-rate')).toBeNull();
    expect(screen.queryByTestId('plan-savings-no-rate')).toBeNull();
    expect(screen.queryByText(/so it is not in the plan/)).toBeNull();
  });
});

describe('Investments', () => {
  it('names a holding with no rate under the value, cost and gains, once', async () => {
    await act(() => setFinance(vtiInChf()));
    await renderScreen(<InvestmentsScreen />);
    expect(textOf('invest-holdings-no-rate')).toMatch(
      /^Value, cost and gains: Leaves out "VTI" \(CHF\): there is no CHF to USD exchange rate yet/,
    );
  });

  it('names sales and dividends with no rate under their totals', async () => {
    await act(() => setFinance(vtiInChf()));
    await renderScreen(<InvestmentsScreen />);
    expect(textOf('invest-realized-no-rate')).toMatch(/^Realized gains: Leaves out "VTI" \(CHF\)/);
    expect(textOf('invest-dividends-no-rate')).toMatch(/^Dividends: Leaves out "VTI" \(CHF\)/);
  });

  it('the realized line follows the year chosen', async () => {
    // Another holding, in USD, bought in 2023 and sold in 2024.
    const vti = base.activities.find((x) => x.securityId === 'sec_vti' && x.type === 'buy')!;
    const data = vtiInChf();
    await act(() =>
      setFinance({
        ...data,
        activities: [
          ...data.activities,
          { ...vti, id: 'act_test_buy', securityId: 'sec_vxus', date: '2023-02-01' },
          {
            ...vti,
            id: 'act_test_sell',
            securityId: 'sec_vxus',
            type: 'sell',
            date: '2024-05-02',
            amount: 450_000,
          },
        ],
      }),
    );
    await renderScreen(<InvestmentsScreen />);
    expect(screen.getByTestId('invest-realized-no-rate')).toBeTruthy();
    await fireEvent.press(screen.getAllByText('2024')[0]!);
    expect(screen.queryByTestId('invest-realized-no-rate')).toBeNull();
    await fireEvent.press(screen.getAllByText('2026')[0]!);
    expect(screen.getByTestId('invest-realized-no-rate')).toBeTruthy();
  });

  it('the lots sheet says its report-currency amounts show 0', async () => {
    await act(() => setFinance(vtiInChf()));
    await renderScreen(<InvestmentsScreen />);
    await fireEvent.press(screen.getByTestId('holding-hold_brokerage_vti'));
    expect(textOf('position-no-rate')).toMatch(/no CHF to USD exchange rate yet/);
  });

  it('nothing when every rate is there', async () => {
    await renderScreen(<InvestmentsScreen />);
    expect(screen.queryByTestId('invest-holdings-no-rate')).toBeNull();
    expect(screen.queryByTestId('invest-realized-no-rate')).toBeNull();
    expect(screen.queryByTestId('invest-dividends-no-rate')).toBeNull();
    await fireEvent.press(screen.getByTestId('holding-hold_brokerage_vti'));
    expect(screen.queryByTestId('position-no-rate')).toBeNull();
  });
});
