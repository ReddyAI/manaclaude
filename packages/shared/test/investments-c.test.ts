import { describe, expect, it } from 'vitest';
import {
  allocationByClass,
  benchmarkComparison,
  deriveLotsFifo,
  dividendsByYear,
  quantityAt,
  resultsFromActivities,
  summarizePosition,
  summarizeRealized,
  type Holding,
  type InvestmentActivity,
  type PricePoint,
  type Security,
  type TaxLot,
} from '../src';

let n = 0;
function act(
  type: InvestmentActivity['type'],
  date: string,
  quantity: string | null,
  amount: number,
  extra: Partial<InvestmentActivity> = {},
): InvestmentActivity {
  n += 1;
  return {
    id: `x${n}`,
    accountId: 'acc',
    securityId: 'sec',
    type,
    date,
    quantity,
    price: null,
    amount,
    fees: 0,
    currency: 'USD',
    splitRatio: null,
    externalId: null,
    source: 'connector',
    ...extra,
  };
}
const base = { holdingId: 'h', accountId: 'acc', securityId: 'sec', currency: 'USD' };

describe('lot selection methods', () => {
  const buys = [
    act('buy', '2024-01-01', '10', -100_000), // 100.00 each
    act('buy', '2024-06-01', '10', -300_000), // 300.00 each
    act('buy', '2025-01-01', '10', -200_000), // 200.00 each
  ];
  const sell = act('sell', '2025-06-01', '10', 250_000);

  it('FIFO is the default and sells the oldest lot', () => {
    const r = deriveLotsFifo({ ...base, activities: [...buys, sell] });
    expect(r.realized[0]).toMatchObject({ acquiredOn: '2024-01-01', gain: 150_000 });
    expect(r.lots.map((l) => l.acquiredOn)).toEqual(['2024-06-01', '2025-01-01']);
  });

  it('LIFO sells the newest lot', () => {
    const r = deriveLotsFifo({ ...base, activities: [...buys, sell], method: 'lifo' });
    expect(r.realized[0]).toMatchObject({ acquiredOn: '2025-01-01', gain: 50_000 });
  });

  it('HIFO sells the lot with the highest cost per unit', () => {
    const r = deriveLotsFifo({ ...base, activities: [...buys, sell], method: 'hifo' });
    expect(r.realized[0]).toMatchObject({ acquiredOn: '2024-06-01', gain: -50_000, term: 'short' });
  });
});

describe('partial sells, splits and terms', () => {
  it('a partial sell leaves the rest of the lot with a pro-rated cost basis', () => {
    const r = deriveLotsFifo({
      ...base,
      activities: [
        act('buy', '2025-01-01', '10', -100_001),
        act('sell', '2025-03-01', '4', 60_000),
      ],
    });
    expect(r.realized).toHaveLength(1);
    expect(r.realized[0]).toMatchObject({ quantity: '4', costBasis: 40_000, proceeds: 60_000 });
    expect(r.lots[0]).toMatchObject({ quantity: '6' });
    // Realized plus remaining cost always equals what was paid.
    expect(r.realized[0]!.costBasis + r.lots[0]!.costBasis).toBe(100_001);
  });

  it('a split multiplies units and keeps total cost', () => {
    const r = deriveLotsFifo({
      ...base,
      activities: [
        act('buy', '2023-05-10', '5', -142_500),
        act('split', '2024-06-10', null, 0, { splitRatio: '10' }),
        act('sell', '2025-01-10', '20', 400_000),
      ],
    });
    expect(r.realized[0]).toMatchObject({ quantity: '20', costBasis: 57_000, gain: 343_000 });
    expect(r.lots[0]).toMatchObject({ quantity: '30', costBasis: 85_500 });
  });

  it('a reverse split reduces units', () => {
    const r = deriveLotsFifo({
      ...base,
      activities: [
        act('buy', '2024-01-01', '100', -100_000),
        act('split', '2024-02-01', null, 0, { splitRatio: '0.1' }),
      ],
    });
    expect(r.lots[0]).toMatchObject({ quantity: '10', costBasis: 100_000 });
  });

  it('a split dated the same day as a buy applies before it', () => {
    const r = deriveLotsFifo({
      ...base,
      activities: [
        act('buy', '2024-02-01', '5', -50_000),
        act('split', '2024-02-01', null, 0, { splitRatio: '2' }),
      ],
    });
    expect(r.lots[0]).toMatchObject({ quantity: '5' });
  });

  it('exactly one year is short term, one day more is long term', () => {
    const r = deriveLotsFifo({
      ...base,
      activities: [
        act('buy', '2024-03-01', '1', -10_000),
        act('sell', '2025-03-01', '1', 12_000),
        act('buy', '2024-03-02', '1', -10_000),
        act('sell', '2025-03-03', '1', 12_000),
      ],
    });
    const byBuy = Object.fromEntries(r.realized.map((g) => [g.acquiredOn, g.term]));
    expect(byBuy['2024-03-01']).toBe('short');
    expect(byBuy['2024-03-02']).toBe('long');
  });

  it('sums dividends and warns when selling more than held', () => {
    const r = deriveLotsFifo({
      ...base,
      activities: [
        act('buy', '2025-01-01', '1', -10_000),
        act('dividend', '2025-04-01', null, 120),
        act('dividend', '2025-07-01', null, 130),
        act('sell', '2025-08-01', '3', 30_000),
      ],
    });
    expect(r.dividends).toBe(250);
    expect(r.warnings.some((w) => w.includes('more units than the lots hold'))).toBe(true);
  });
});

describe('realized gains from activities', () => {
  const acts = [
    act('buy', '2023-01-01', '10', -100_000, { securityId: 'a' }),
    act('buy', '2025-01-01', '10', -120_000, { securityId: 'a' }),
    act('sell', '2025-06-01', '12', 200_000, { securityId: 'a' }),
    act('buy', '2025-02-01', '5', -50_000, { securityId: 'b' }),
    act('sell', '2025-12-01', '5', 40_000, { securityId: 'b' }),
    act('dividend', '2025-03-01', null, 500, { securityId: 'a' }),
    act('dividend', '2024-03-01', null, 300, { securityId: 'a' }),
  ];

  it('groups by account and security and sorts newest first', () => {
    const r = resultsFromActivities(acts);
    expect(r.realized.map((g) => g.soldOn)).toEqual(['2025-12-01', '2025-06-01', '2025-06-01']);
    expect(r.realized).toHaveLength(3);
  });

  it('totals short and long term and filters by year', () => {
    const { realized } = resultsFromActivities(acts);
    const all = summarizeRealized(realized);
    // a: 10 long (cost 100000, proceeds 166667) + 2 short (cost 24000, proceeds 33333); b: short -10000
    expect(all.gain).toBe(all.longTermGain + all.shortTermGain);
    expect(all.proceeds).toBe(200_000 + 40_000);
    expect(all.costBasis).toBe(100_000 + 24_000 + 50_000);
    expect(all.longTermGain).toBe(66_667);
    const y = summarizeRealized(realized, { year: 2024 });
    expect(y.gain).toBe(0);
  });

  it('adds dividends per year', () => {
    const { dividends } = resultsFromActivities(acts);
    expect(dividendsByYear(dividends)).toEqual([
      { year: 2025, amount: 500 },
      { year: 2024, amount: 300 },
    ]);
  });
});

describe('positions and allocation', () => {
  const holding: Holding = {
    id: 'h1',
    accountId: 'acc',
    securityId: 'a',
    quantity: '30',
    price: '12.00',
    priceAsOf: '2026-11-01T00:00:00.000Z',
    marketValue: 36_000,
    costBasis: 30_000,
    currency: 'USD',
    source: 'derived',
  };
  const lots: TaxLot[] = [
    {
      id: 'l1',
      holdingId: 'h1',
      acquiredOn: '2024-01-01',
      quantity: '10',
      costBasis: 10_000,
      currency: 'USD',
      source: 'derived',
      externalId: null,
    },
    {
      id: 'l2',
      holdingId: 'h1',
      acquiredOn: '2026-05-01',
      quantity: '20',
      costBasis: 20_000,
      currency: 'USD',
      source: 'derived',
      externalId: null,
    },
  ];

  it('rolls lots up into cost basis, unrealized gain and short/long split', () => {
    const p = summarizePosition(holding, lots, '2026-11-01');
    expect(p.costBasis).toBe(30_000);
    expect(p.unrealized).toBe(6_000);
    expect(p.unrealizedPct).toBeCloseTo(0.2);
    expect(p.longTermUnrealized).toBe(12_000 - 10_000);
    expect(p.shortTermUnrealized).toBe(24_000 - 20_000);
    expect(p.lotSource).toBe('derived');
  });

  it('uses the holding cost basis when there are no lots', () => {
    const p = summarizePosition(holding, [], '2026-11-01');
    expect(p.costBasis).toBe(30_000);
    expect(p.lotSource).toBe('none');
  });

  it('computes allocation shares by asset class', () => {
    const secs = [
      { id: 'a', assetClass: 'us_stocks' },
      { id: 'b', assetClass: 'bonds' },
    ] as Security[];
    const hs = [
      { ...holding, id: 'x', securityId: 'a', marketValue: 75 },
      { ...holding, id: 'y', securityId: 'b', marketValue: 25 },
    ];
    const out = allocationByClass(hs, secs, (h) => h.marketValue);
    expect(out[0]).toMatchObject({ assetClass: 'us_stocks', share: 0.75 });
    expect(out[1]).toMatchObject({ assetClass: 'bonds', share: 0.25 });
  });
});

describe('quantityAt and the S&P 500 benchmark', () => {
  const acts = [
    act('buy', '2025-01-15', '10', -10_000, { securityId: 'a' }),
    act('split', '2025-03-15', null, 0, { securityId: 'a', splitRatio: '2' }),
    act('buy', '2025-04-15', '10', -8_000, { securityId: 'a' }),
  ];
  it('replays buys and splits up to a date', () => {
    expect(quantityAt(acts, '2025-02-01')).toBe('10');
    expect(quantityAt(acts, '2025-03-20')).toBe('20');
    expect(quantityAt(acts, '2025-05-01')).toBe('30');
  });

  const price = (securityId: string, date: string, close: string): PricePoint => ({
    securityId,
    date,
    close,
    currency: 'USD',
  });
  const dates = ['2025-01-31', '2025-02-28', '2025-03-31', '2025-04-30'];

  it('matches the benchmark exactly when the portfolio tracks it', () => {
    const prices = dates.flatMap((d, i) => {
      const p = String(100 + i * 10);
      return [price('a', d, p), price('spy', d, p)];
    });
    const r = benchmarkComparison({
      activities: [act('buy', '2025-01-15', '10', -100_000, { securityId: 'a' })],
      prices,
      benchmarkSecurityId: 'spy',
      dates,
      fx: () => 1,
    });
    expect(r.points).toHaveLength(4);
    expect(r.portfolioGain).toBeCloseTo(r.benchmarkGain, 6);
    expect(r.difference).toBeCloseTo(0, 6);
  });

  it('shows a positive difference when the holding beats the index', () => {
    const prices = dates.flatMap((d, i) => [
      price('a', d, String(100 + i * 20)),
      price('spy', d, String(100 + i * 10)),
    ]);
    const r = benchmarkComparison({
      activities: [act('buy', '2025-01-15', '10', -100_000, { securityId: 'a' })],
      prices,
      benchmarkSecurityId: 'spy',
      dates,
      fx: () => 1,
    });
    // 10 units: +60 per unit = 600.00 portfolio gain; benchmark +30% of 1000 = 300.00
    expect(r.portfolioGain).toBeCloseTo(600, 6);
    expect(r.benchmarkGain).toBeCloseTo(300, 6);
    expect(r.difference).toBeCloseTo(300, 6);
  });

  it('puts a later buy into the benchmark at the same moment', () => {
    const prices = dates.flatMap((d, i) => [
      price('a', d, String(100 + i * 10)),
      price('spy', d, String(100 + i * 10)),
    ]);
    const r = benchmarkComparison({
      activities: [
        act('buy', '2025-01-15', '10', -100_000, { securityId: 'a' }),
        act('buy', '2025-03-20', '5', -60_000, { securityId: 'a' }),
      ],
      prices,
      benchmarkSecurityId: 'spy',
      dates,
      fx: () => 1,
    });
    expect(r.netInvested).toBeCloseTo(600, 6);
    expect(r.difference).toBeCloseTo(0, 6);
  });

  it('returns an empty result for fewer than two dates', () => {
    const r = benchmarkComparison({
      activities: [],
      prices: [],
      benchmarkSecurityId: 'spy',
      dates: ['2025-01-01'],
      fx: () => 1,
    });
    expect(r.points).toEqual([]);
  });
});
