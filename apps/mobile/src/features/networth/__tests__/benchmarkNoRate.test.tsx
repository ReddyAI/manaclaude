import { act, screen } from '@testing-library/react-native';
import {
  DEFAULT_SETTINGS,
  benchmarkComparison,
  findRate,
  formatMoney,
  fromMajor,
  type FinanceDataset,
  type InvestmentActivity,
  type PricePoint,
} from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import { updateSettings } from '../../../data/settingsStore';
import { setFinance } from '../../../data/store';
import { renderScreen } from '../../planning/__tests__/helpers';
import { InvestmentsScreen } from '../InvestmentsScreen';
import { benchmarkLeftOut } from '../benchmarkNoRate';

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
 * Block R: the S&P 500 comparison names the holdings and trades it leaves
 * out for want of an exchange rate. Invented data; the sample rates cover
 * USD, INR and EUR, not CHF. Numbers are unchanged.
 */

const base = createSampleData();
const vtiInChf = (): FinanceDataset => ({
  ...base,
  holdings: base.holdings.map((h) => (h.securityId === 'sec_vti' ? { ...h, currency: 'CHF' } : h)),
  activities: base.activities.map((a) =>
    a.securityId === 'sec_vti' ? { ...a, currency: 'CHF' } : a,
  ),
});
const textOf = (id: string) => String(screen.getByTestId(id).props.children);

beforeEach(async () => {
  await act(() => {
    setFinance(createSampleData());
    updateSettings({ ...DEFAULT_SETTINGS });
  });
});

describe('benchmarkLeftOut', () => {
  const act1 = (over: Partial<InvestmentActivity>): InvestmentActivity => ({
    id: 'a',
    accountId: 'acc',
    securityId: 'sec_x',
    type: 'buy',
    date: '2026-01-10',
    quantity: '10',
    price: '100',
    amount: -1000_00,
    fees: 0,
    currency: 'CHF',
    splitRatio: null,
    externalId: null,
    source: 'manual',
    ...over,
  });
  const prices: PricePoint[] = [
    { securityId: 'sec_x', date: '2026-01-01', close: '100' },
    { securityId: 'sec_y', date: '2026-01-01', close: '50' },
  ] as PricePoint[];
  const dates = ['2026-03-01', '2026-06-01', '2026-09-01'];
  const fx = (c: string) => (c === 'USD' ? 1 : null);

  it('names a holding held during the range in a currency with no rate', () => {
    expect(benchmarkLeftOut({ activities: [act1({})], prices, dates, fx })).toEqual([
      { securityId: 'sec_x', currency: 'CHF' },
    ]);
  });

  it('does not name one sold before the range or with no price', () => {
    const sold = [act1({}), act1({ id: 'b', type: 'sell', date: '2026-02-01', amount: 1000_00 })];
    expect(benchmarkLeftOut({ activities: sold, prices, dates, fx })).toEqual([]);
    const noPrice = [act1({ securityId: 'sec_none' })];
    expect(benchmarkLeftOut({ activities: noPrice, prices, dates, fx })).toEqual([]);
  });

  it('names a buy in the range in another currency, even when the holding is counted', () => {
    const acts = [
      act1({ securityId: 'sec_y', currency: 'USD' }),
      act1({ id: 'b', securityId: 'sec_y', date: '2026-04-01', currency: 'CHF' }),
    ];
    expect(benchmarkLeftOut({ activities: acts, prices, dates, fx })).toEqual([
      { securityId: 'sec_y', currency: 'CHF' },
    ]);
  });

  it('a buy on the first date is not a flow; nothing for fewer than two dates', () => {
    const acts = [
      act1({ securityId: 'sec_y', currency: 'USD' }),
      act1({ id: 'b', securityId: 'sec_y', date: '2026-03-01', currency: 'CHF' }),
    ];
    expect(benchmarkLeftOut({ activities: acts, prices, dates, fx })).toEqual([]);
    expect(benchmarkLeftOut({ activities: [act1({})], prices, dates: ['2026-03-01'], fx })).toEqual(
      [],
    );
  });

  it('does not name a payout or a buy after the range: they move no money into the index', () => {
    const acts = [
      act1({ securityId: 'sec_y', currency: 'USD' }),
      act1({
        id: 'b',
        securityId: 'sec_y',
        type: 'dividend',
        date: '2026-04-01',
        quantity: null,
        amount: 5_00,
        currency: 'CHF',
      }),
      act1({ id: 'c', securityId: 'sec_y', date: '2026-10-01', currency: 'CHF' }),
    ];
    expect(benchmarkLeftOut({ activities: acts, prices, dates, fx })).toEqual([]);
  });

  it('names nothing when every currency has a rate', () => {
    expect(
      benchmarkLeftOut({ activities: [act1({ currency: 'USD' })], prices, dates, fx }),
    ).toEqual([]);
  });

  it('a holding it names really adds nothing to the comparison', () => {
    const data = vtiInChf();
    const bench = data.securities.find((s) => s.isBenchmark)!;
    const ds = data.prices
      .filter((p) => p.securityId === bench.id && p.date >= '2025-11-05')
      .map((p) => p.date)
      .sort();
    const fxUsd = (c: string) =>
      c === 'USD' ? 1 : (findRate(data.fxRates, c, 'USD')?.rate ?? null);
    const named = benchmarkLeftOut({
      activities: data.activities,
      prices: data.prices,
      dates: ds,
      fx: fxUsd,
    });
    expect(named.map((n) => n.securityId)).toEqual(['sec_vti']);
    const run = (acts: InvestmentActivity[]) =>
      benchmarkComparison({
        activities: acts,
        prices: data.prices,
        benchmarkSecurityId: bench.id,
        dates: ds,
        fx: fxUsd,
      });
    const without = data.activities.filter((a) => a.securityId !== 'sec_vti');
    expect(run(data.activities).portfolioGain).toBeCloseTo(run(without).portfolioGain, 6);
  });
});

describe('Investments, Against the S&P 500', () => {
  it('names a holding with no rate under the comparison', async () => {
    await act(() => setFinance(vtiInChf()));
    await renderScreen(<InvestmentsScreen />);
    expect(textOf('bench-no-rate')).toMatch(
      /^Comparison: Leaves out "VTI" \(CHF\): there is no CHF to USD exchange rate yet\. Refresh rates in Settings, Exchange rates\.$/,
    );
  });

  it('keeps the numbers as they were', async () => {
    const data = vtiInChf();
    await act(() => setFinance(data));
    await renderScreen(<InvestmentsScreen />);
    // The 1Y comparison, worked out directly with the same inputs.
    const bench = data.securities.find((s) => s.isBenchmark)!;
    const ds = data.prices
      .filter((p) => p.securityId === bench.id && p.date >= '2025-11-05')
      .map((p) => p.date)
      .sort();
    const gain = benchmarkComparison({
      activities: data.activities,
      prices: data.prices,
      benchmarkSecurityId: bench.id,
      dates: ds,
      fx: (c) => (c === 'USD' ? 1 : (findRate(data.fxRates, c, 'USD')?.rate ?? null)),
    }).portfolioGain;
    const shown = formatMoney(fromMajor(gain, 'USD'), 'USD', { cents: 'never', sign: 'always' });
    expect(screen.getByTestId('bench-portfolio')).toHaveTextContent(shown, { exact: false });
    expect(screen.getByTestId('bench-no-rate')).toBeTruthy();
  });

  it('says nothing when every rate is there', async () => {
    await renderScreen(<InvestmentsScreen />);
    expect(screen.getByTestId('bench-portfolio')).toBeTruthy();
    expect(screen.queryByTestId('bench-no-rate')).toBeNull();
  });

  it('says nothing when there is nothing to compare', async () => {
    const data = vtiInChf();
    const bench = data.securities.find((s) => s.isBenchmark)!;
    await act(() =>
      setFinance({ ...data, prices: data.prices.filter((p) => p.securityId !== bench.id) }),
    );
    await renderScreen(<InvestmentsScreen />);
    expect(screen.queryByTestId('bench-no-rate')).toBeNull();
  });
});
