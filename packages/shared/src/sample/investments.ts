import type { DecimalString, Id, IsoDateTime, LocalDate } from '../model/common';
import type {
  Holding,
  InvestmentActivity,
  PricePoint,
  Security,
  TaxLot,
} from '../model/investment';
import { addMonths } from '../dates/dates';
import { deriveLotsFifo } from '../investments/lots';
import { addDec, valueInMinor } from '../money/decimal';
import { createRandom } from './random';

/** Sample securities and prices. Prices are invented for testing, not quotes. */
export const SAMPLE_SECURITIES: Security[] = [
  {
    id: 'sec_vti',
    symbol: 'VTI',
    name: 'Total Stock Market ETF',
    type: 'etf',
    exchange: 'ARCA',
    currency: 'USD',
    isin: null,
    assetClass: 'us_stocks',
    isBenchmark: false,
  },
  {
    id: 'sec_vxus',
    symbol: 'VXUS',
    name: 'Total International Stock ETF',
    type: 'etf',
    exchange: 'NASDAQ',
    currency: 'USD',
    isin: null,
    assetClass: 'intl_stocks',
    isBenchmark: false,
  },
  {
    id: 'sec_aapl',
    symbol: 'AAPL',
    name: 'Apple Inc.',
    type: 'equity',
    exchange: 'NASDAQ',
    currency: 'USD',
    isin: null,
    assetClass: 'us_stocks',
    isBenchmark: false,
  },
  {
    id: 'sec_nvda',
    symbol: 'NVDA',
    name: 'NVIDIA Corp.',
    type: 'equity',
    exchange: 'NASDAQ',
    currency: 'USD',
    isin: null,
    assetClass: 'us_stocks',
    isBenchmark: false,
  },
  {
    id: 'sec_spy',
    symbol: 'SPY',
    name: 'S&P 500 ETF (benchmark)',
    type: 'etf',
    exchange: 'ARCA',
    currency: 'USD',
    isin: null,
    assetClass: 'us_stocks',
    isBenchmark: true,
  },
  {
    id: 'sec_lcidx',
    symbol: 'LCIDX',
    name: 'Large Cap Index Fund (sample)',
    type: 'mutual_fund',
    exchange: null,
    currency: 'USD',
    isin: null,
    assetClass: 'us_stocks',
    isBenchmark: false,
  },
  {
    id: 'sec_bdidx',
    symbol: 'BDIDX',
    name: 'Bond Index Fund (sample)',
    type: 'mutual_fund',
    exchange: null,
    currency: 'USD',
    isin: null,
    assetClass: 'bonds',
    isBenchmark: false,
  },
  {
    id: 'sec_reliance',
    symbol: 'RELIANCE',
    name: 'Reliance Industries',
    type: 'equity',
    exchange: 'NSE',
    currency: 'INR',
    isin: null,
    assetClass: 'india_stocks',
    isBenchmark: false,
  },
  {
    id: 'sec_infy',
    symbol: 'INFY',
    name: 'Infosys',
    type: 'equity',
    exchange: 'NSE',
    currency: 'INR',
    isin: null,
    assetClass: 'india_stocks',
    isBenchmark: false,
  },
  {
    id: 'sec_tcs',
    symbol: 'TCS',
    name: 'Tata Consultancy Services',
    type: 'equity',
    exchange: 'BSE',
    currency: 'INR',
    isin: null,
    assetClass: 'india_stocks',
    isBenchmark: false,
  },
  {
    id: 'sec_niftybees',
    symbol: 'NIFTYBEES',
    name: 'Nifty 50 ETF',
    type: 'etf',
    exchange: 'NSE',
    currency: 'INR',
    isin: null,
    assetClass: 'india_stocks',
    isBenchmark: false,
  },
  {
    id: 'sec_btc',
    symbol: 'BTC',
    name: 'Bitcoin',
    type: 'crypto',
    exchange: 'CRYPTO',
    currency: 'USD',
    isin: null,
    assetClass: 'crypto',
    isBenchmark: false,
  },
  {
    id: 'sec_eth',
    symbol: 'ETH',
    name: 'Ethereum',
    type: 'crypto',
    exchange: 'CRYPTO',
    currency: 'USD',
    isin: null,
    assetClass: 'crypto',
    isBenchmark: false,
  },
];

export const SAMPLE_PRICES: Record<Id, DecimalString> = {
  sec_vti: '335.20',
  sec_vxus: '72.15',
  sec_aapl: '271.40',
  sec_nvda: '188.25',
  sec_spy: '682.50',
  sec_lcidx: '142.11',
  sec_bdidx: '21.45',
  sec_reliance: '1452.30',
  sec_infy: '1618.40',
  sec_tcs: '3320.00',
  sec_niftybees: '288.75',
  sec_btc: '104250.00',
  sec_eth: '3880.00',
};

type ActSeed = [
  type: InvestmentActivity['type'],
  date: LocalDate,
  quantity: string | null,
  price: string | null,
  amount: number,
  extra?: Partial<InvestmentActivity>,
];

/** [accountId, securityId, currency, activities] */
const ACTIVITY_SEEDS: [Id, Id, string, ActSeed[]][] = [
  [
    'acc_brokerage',
    'sec_vti',
    'USD',
    [
      ['buy', '2023-03-15', '20', '200.12', -400_240],
      ['buy', '2024-01-10', '15', '236.50', -354_750],
      ['dividend', '2024-03-27', null, null, 3_842],
      ['dividend', '2024-06-28', null, null, 4_015],
      ['buy', '2025-02-12', '10', '295.30', -295_300],
      ['sell', '2026-03-20', '12', '305.10', 366_120],
      ['dividend', '2026-03-26', null, null, 5_210],
      ['buy', '2026-06-15', '8', '318.40', -254_720],
      ['dividend', '2026-06-29', null, null, 5_480],
      ['dividend', '2026-09-29', null, null, 5_655],
    ],
  ],
  [
    'acc_brokerage',
    'sec_aapl',
    'USD',
    [
      ['buy', '2022-08-01', '30', '161.51', -484_530],
      ['buy', '2025-11-20', '10', '268.00', -268_000],
      ['dividend', '2026-08-14', null, null, 1_040],
    ],
  ],
  [
    'acc_brokerage',
    'sec_nvda',
    'USD',
    [
      ['buy', '2023-05-10', '5', '285.00', -142_500],
      ['split', '2024-06-10', null, null, 0, { splitRatio: '10' }],
      ['buy', '2025-04-08', '20', '96.30', -192_600],
    ],
  ],
  ['acc_brokerage', 'sec_vxus', 'USD', [['buy', '2024-03-01', '40', '59.80', -239_200]]],
  [
    'acc_demat',
    'sec_reliance',
    'INR',
    [
      ['buy', '2022-04-11', '50', '2640.00', -13_200_000],
      ['split', '2024-10-28', null, null, 0, { splitRatio: '2' }], // 1:1 bonus issue
    ],
  ],
  [
    'acc_demat',
    'sec_infy',
    'INR',
    [
      ['buy', '2023-06-05', '40', '1285.50', -5_142_000],
      ['dividend', '2025-06-02', null, null, 88_000],
    ],
  ],
  ['acc_demat', 'sec_niftybees', 'INR', [['buy', '2024-08-20', '300', '270.10', -8_103_000]]],
  ['acc_demat', 'sec_tcs', 'INR', [['buy', '2025-01-15', '10', '4100.00', -4_100_000]]],
  [
    'acc_crypto',
    'sec_btc',
    'USD',
    [
      ['buy', '2021-03-01', '0.15', '49500.00', -742_500],
      ['buy', '2024-11-12', '0.05', '88200.00', -441_000],
    ],
  ],
  ['acc_crypto', 'sec_eth', 'USD', [['buy', '2022-06-20', '2.5', '1120.00', -280_000]]],
];

/** 401(k): lots come from the broker (Plaid tax_lots), so there are no activities. */
const BROKER_LOTS: [Id, Id, [LocalDate, string, number][]][] = [
  [
    'acc_401k',
    'sec_lcidx',
    [
      ['2021-01-15', '120.000', 1_212_000],
      ['2022-07-15', '140.500', 1_330_535],
      ['2024-01-15', '151.838', 1_802_317],
    ],
  ],
  [
    'acc_401k',
    'sec_bdidx',
    [
      ['2022-01-15', '200.000', 446_000],
      ['2024-06-14', '180.120', 360_240],
    ],
  ],
];

export interface SampleInvestmentData {
  securities: Security[];
  holdings: Holding[];
  taxLots: TaxLot[];
  activities: InvestmentActivity[];
  prices: PricePoint[];
  /** Cash balances inside investment accounts, minor units. */
  cashByAccount: Record<Id, number>;
}

export function sampleInvestmentData(today: LocalDate, now: IsoDateTime): SampleInvestmentData {
  const activities: InvestmentActivity[] = [];
  const holdings: Holding[] = [];
  const taxLots: TaxLot[] = [];

  let n = 0;
  for (const [accountId, securityId, currency, seeds] of ACTIVITY_SEEDS) {
    const acts: InvestmentActivity[] = seeds.map(
      ([type, date, quantity, price, amount, extra]) => ({
        id: `act_${String(++n).padStart(3, '0')}`,
        accountId,
        securityId,
        type,
        date,
        quantity,
        price,
        amount,
        fees: 0,
        currency,
        splitRatio: null,
        externalId: `ext_act_${n}`,
        source: 'connector',
        ...(extra ?? {}),
      }),
    );
    activities.push(...acts);
    const holdingId = `hold_${accountId.replace('acc_', '')}_${securityId.replace('sec_', '')}`;
    const derived = deriveLotsFifo({
      activities: acts,
      holdingId,
      accountId,
      securityId,
      currency,
    });
    const quantity = derived.lots.reduce((q, l) => addDec(q, l.quantity), '0');
    const price = SAMPLE_PRICES[securityId] ?? '0';
    holdings.push({
      id: holdingId,
      accountId,
      securityId,
      quantity,
      price,
      priceAsOf: now,
      marketValue: valueInMinor(quantity, price, currency),
      costBasis: derived.lots.reduce((s, l) => s + l.costBasis, 0),
      currency,
      source: 'derived',
    });
    taxLots.push(...derived.lots);
  }

  for (const [accountId, securityId, lots] of BROKER_LOTS) {
    const holdingId = `hold_${accountId.replace('acc_', '')}_${securityId.replace('sec_', '')}`;
    const price = SAMPLE_PRICES[securityId] ?? '0';
    let quantity = '0';
    let cost = 0;
    lots.forEach(([acquiredOn, q, basis], i) => {
      quantity = addDec(quantity, q);
      cost += basis;
      taxLots.push({
        id: `${holdingId}_lot${i + 1}`,
        holdingId,
        acquiredOn,
        quantity: q,
        costBasis: basis,
        currency: 'USD',
        source: 'broker',
        externalId: `plaid_lot_${i + 1}`,
      });
    });
    holdings.push({
      id: holdingId,
      accountId,
      securityId,
      quantity,
      price,
      priceAsOf: now,
      marketValue: valueInMinor(quantity, price, 'USD'),
      costBasis: cost,
      currency: 'USD',
      source: 'connector',
    });
  }

  // Monthly closes for two years: a random walk that ends at today's sample price.
  const rnd = createRandom(42);
  const prices: PricePoint[] = [];
  for (const sec of SAMPLE_SECURITIES) {
    const end = Number(SAMPLE_PRICES[sec.id] ?? '0');
    const drift = sec.assetClass === 'crypto' ? 0.03 : sec.assetClass === 'bonds' ? 0.002 : 0.011;
    const vol = sec.assetClass === 'crypto' ? 0.12 : sec.assetClass === 'bonds' ? 0.01 : 0.045;
    const values: number[] = [end];
    for (let m = 1; m <= 24; m += 1) {
      const prev = values[m - 1] ?? end;
      values.push(prev / (1 + drift + (rnd.next() - 0.5) * 2 * vol));
    }
    values.reverse();
    values.forEach((v, m) => {
      prices.push({
        securityId: sec.id,
        date: addMonths(today, m - 24),
        close: v.toFixed(2),
        currency: sec.currency,
      });
    });
  }

  return {
    securities: SAMPLE_SECURITIES,
    holdings,
    taxLots,
    activities,
    prices,
    cashByAccount: { acc_brokerage: 120_418, acc_401k: 0, acc_demat: 1_254_000, acc_crypto: 0 },
  };
}
