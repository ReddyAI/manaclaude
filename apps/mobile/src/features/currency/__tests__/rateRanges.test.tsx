import { act, render, screen, waitFor } from '@testing-library/react-native';
import { DEFAULT_SETTINGS, type FxRate, type Transaction } from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import { setBackendConfigForTests } from '../../../data/backend/config';
import { fakeBackend, json } from '../../../data/backend/__tests__/helpers';
import { setBackendStatus } from '../../../data/backend/status';
import { updateSettings } from '../../../data/settingsStore';
import { setFinance } from '../../../data/store';
import { ExchangeRatesSection } from '../../settings/sections/ExchangeRatesSection';
import { usdInrStore } from '../fxApi';
import { olderThanRatesText, rateRanges, rateRangeText } from '../rateRanges';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

/** Block V: how far back the Worker's day rates go, per currency. Invented data only. */

const rate = (quote: string, date: string, value = 1): FxRate => ({
  base: 'USD',
  quote,
  rate: value,
  asOf: `${date}T14:00:00.000Z`,
  date,
  source: 'frankfurter_ecb',
});
const txn = (id: string, currency: string, date: string): Transaction =>
  ({
    ...createSampleData({ today: '2026-11-05' }).transactions[0]!,
    id,
    currency,
    date,
  }) as Transaction;

const rates = [
  rate('INR', '2026-06-17', 87),
  rate('INR', '2026-11-04', 88),
  rate('EUR', '2026-09-01', 0.9),
];

describe('rateRanges', () => {
  it('gives each currency its oldest and newest day and what the rates are against', () => {
    const [eur, inr, usd] = rateRanges(
      {
        accounts: [],
        transactions: [
          txn('a', 'INR', '2026-08-01'),
          txn('b', 'EUR', '2026-10-01'),
          txn('c', 'USD', '2026-01-01'),
        ],
        fxRates: rates,
      },
      ['USD'],
    );
    expect(inr).toMatchObject({
      currency: 'INR',
      from: '2026-06-17',
      to: '2026-11-04',
      days: 2,
      against: ['USD'],
      olderThanRates: false,
      noRate: false,
    });
    expect(eur).toMatchObject({ currency: 'EUR', from: '2026-09-01', to: '2026-09-01', days: 1 });
    expect(usd).toMatchObject({
      currency: 'USD',
      isReportCurrency: true,
      oldestTransaction: null,
      olderThanRates: false,
      against: ['EUR', 'INR'],
    });
  });

  it('says when the oldest transaction is older than the oldest rate', () => {
    const [inr] = rateRanges(
      {
        accounts: [],
        transactions: [txn('a', 'INR', '2026-03-03'), txn('b', 'INR', '2026-09-03')],
        fxRates: rates,
      },
      ['USD'],
    );
    expect(inr).toMatchObject({ oldestTransaction: '2026-03-03', olderThanRates: true });
    expect(olderThanRatesText(inr!)).toBe(
      'Your oldest INR transaction is from Mar 3, 2026, before the oldest INR rate, so reports before Jun 17, 2026 use the Jun 17, 2026 rate.',
    );
  });

  it('says nothing about older transactions on the oldest rate day itself', () => {
    const [inr] = rateRanges(
      { accounts: [], transactions: [txn('a', 'INR', '2026-06-17')], fxRates: rates },
      ['USD'],
    );
    expect(inr!.olderThanRates).toBe(false);
    expect(olderThanRatesText(inr!)).toBeNull();
  });

  it('a report currency needs no rate for its own transactions, but does in Both mode', () => {
    const data = { accounts: [], transactions: [txn('c', 'USD', '2026-01-01')], fxRates: rates };
    expect(rateRanges(data, ['USD'])[0]).toMatchObject({
      isReportCurrency: true,
      olderThanRates: false,
    });
    expect(rateRanges(data, ['USD', 'INR'])[0]).toMatchObject({
      isReportCurrency: false,
      olderThanRates: true,
      oldestTransaction: '2026-01-01',
    });
  });

  it('names a currency with no rate at all in the words blocks L, M, O and R use', () => {
    const [chf] = rateRanges(
      { accounts: [], transactions: [txn('a', 'CHF', '2026-10-01')], fxRates: rates },
      ['USD'],
    );
    expect(chf).toMatchObject({ noRate: true, from: null });
    expect(rateRangeText(chf!, 'USD')).toBe(
      'CHF: there is no CHF to USD exchange rate yet, so totals leave out amounts in CHF. Refresh rates in Settings, Exchange rates.',
    );
  });

  it('counts accounts as well as transactions, and skips hidden accounts', () => {
    const sample = createSampleData({ today: '2026-11-05' });
    const acc = (currency: string, hidden: boolean) => ({
      ...sample.accounts[0]!,
      currency,
      hidden,
    });
    const list = rateRanges(
      { accounts: [acc('GBP', false), acc('JPY', true)], transactions: [], fxRates: rates },
      ['USD'],
    );
    expect(list.map((r) => r.currency)).toEqual(['GBP']);
  });

  it('writes the range in words', () => {
    const [, inr] = rateRanges(
      {
        accounts: [],
        transactions: [txn('a', 'INR', '2026-08-01'), txn('b', 'EUR', '2026-10-01')],
        fxRates: rates,
      },
      ['USD'],
    );
    expect(rateRangeText(inr!, 'USD')).toBe(
      'INR: day rates from Jun 17, 2026 to Nov 4, 2026 (2 days), against USD.',
    );
  });
});

describe('Settings, Exchange rates', () => {
  let backend: ReturnType<typeof fakeBackend>;
  beforeEach(async () => {
    usdInrStore.reset();
    backend = fakeBackend({
      'GET /v1/fx/latest': () =>
        json(200, {
          base: 'USD',
          quote: 'INR',
          rate: 88,
          asOf: '2026-11-04T14:00:00.000Z',
          source: 'frankfurter_ecb',
        }),
    });
    await act(() => {
      updateSettings({ ...DEFAULT_SETTINGS });
      setBackendConfigForTests({ url: 'https://api.demo.test', token: 'demo-token' });
      const sample = createSampleData({ today: '2026-11-05' });
      setFinance({
        ...sample,
        fxRates: rates,
        transactions: [
          txn('a', 'INR', '2026-03-03'),
          txn('b', 'CHF', '2026-10-01'),
          txn('c', 'USD', '2026-10-02'),
        ],
      });
    });
  });
  afterEach(async () => {
    backend.restore();
    await act(() => setBackendStatus({ mode: 'sample' }));
  });

  it("lists each currency's range once the Worker's data is on screen", async () => {
    await act(() => setBackendStatus({ mode: 'live' }));
    await render(<ExchangeRatesSection />);
    await waitFor(() => expect(screen.getByTestId('rate-ranges')).toBeTruthy());
    expect(screen.getByTestId('rate-range-INR')).toHaveTextContent(
      /INR: day rates from Jun 17, 2026 to Nov 4, 2026/,
    );
    expect(screen.getByTestId('rate-range-older-INR')).toHaveTextContent(
      /from Mar 3, 2026, before the oldest INR rate/,
    );
    expect(screen.getByTestId('rate-range-CHF')).toHaveTextContent(
      /there is no CHF to USD exchange rate yet/,
    );
    expect(screen.queryByTestId('rate-range-older-USD')).toBeNull();
  });

  it('does not describe sample rates as the Worker’s', async () => {
    await act(() => setBackendStatus({ mode: 'sample' }));
    await render(<ExchangeRatesSection />);
    expect(screen.queryByTestId('rate-ranges')).toBeNull();
    expect(screen.getByText(/Shown once your Worker's data has loaded/)).toBeTruthy();
  });
});
