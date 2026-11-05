import { act, fireEvent, screen } from '@testing-library/react-native';
import { renderScreen } from '../../planning/__tests__/helpers';
import { DEFAULT_SETTINGS, resultsFromActivities, summarizeRealized } from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import { updateSettings } from '../../../data/settingsStore';
import { getFinance, setFinance } from '../../../data/store';
import { InvestmentsScreen } from '../InvestmentsScreen';
import { NetWorthScreen } from '../NetWorthScreen';

describe('Investments', () => {
  beforeEach(async () => {
    await act(() => {
      setFinance(createSampleData());
      updateSettings({ ...DEFAULT_SETTINGS });
    });
  });

  it('shows totals, positions, realized gains and the benchmark', async () => {
    await renderScreen(<InvestmentsScreen />);
    expect(screen.getByTestId('invest-total')).toBeTruthy();
    expect(screen.getByTestId('holding-hold_brokerage_vti')).toBeTruthy();
    expect(screen.getByTestId('realized-total')).toBeTruthy();
    expect(screen.getByTestId('bench-portfolio')).toBeTruthy();
    expect(screen.getByTestId('bench-chart')).toBeTruthy();
    expect(screen.getByTestId('dividends-2026')).toBeTruthy();
  });

  it('opens the per-lot table with term and cost basis', async () => {
    await renderScreen(<InvestmentsScreen />);
    await fireEvent.press(screen.getByTestId('holding-hold_brokerage_vti'));
    const lots = getFinance().taxLots.filter((l) => l.holdingId === 'hold_brokerage_vti');
    expect(lots.length).toBeGreaterThan(1);
    for (const lot of lots) expect(screen.getByTestId(`lot-${lot.id}`)).toBeTruthy();
    expect(screen.getByTestId('position-cost')).toBeTruthy();
    expect(screen.getAllByText('long').length).toBeGreaterThan(0);
    expect(screen.getByText(/derived from buys and sells, first in first out/)).toBeTruthy();
  });

  it('labels broker lots as coming from the broker', async () => {
    await renderScreen(<InvestmentsScreen />);
    await fireEvent.press(screen.getByTestId('holding-hold_401k_lcidx'));
    expect(screen.getByText('Lots from the broker.')).toBeTruthy();
  });

  it('sample realized gains match the FIFO sell of VTI', () => {
    const { realized } = resultsFromActivities(getFinance().activities);
    const vti = realized.filter((r) => r.securityId === 'sec_vti');
    // 12 sold on 2026-03-20: 12 of the 20 shares bought 2023-03-15 at 200.12.
    expect(vti).toHaveLength(1);
    expect(vti[0]).toMatchObject({ acquiredOn: '2023-03-15', quantity: '12', term: 'long' });
    expect(summarizeRealized(vti).gain).toBe(366_120 - Math.round((400_240 * 12) / 20));
  });

  it('shows the same screen in INR', async () => {
    await act(() => updateSettings({ displayCurrencyMode: 'INR' }));
    await renderScreen(<InvestmentsScreen />);
    expect(screen.getAllByText(/₹/).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/^\$/).length).toBe(0);
  });
});

describe('Net worth links', () => {
  it('links to investments and planning', async () => {
    await act(() => setFinance(createSampleData()));
    await renderScreen(<NetWorthScreen />);
    expect(screen.getByLabelText('Open investments')).toBeTruthy();
    expect(screen.getByLabelText('Open retirement and goals')).toBeTruthy();
  });
});
