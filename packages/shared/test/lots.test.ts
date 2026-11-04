import { describe, expect, it } from 'vitest';
import { deriveLotsFifo, holdingTerm, lotPerformance, type InvestmentActivity } from '../src';

let n = 0;
function act(type: InvestmentActivity['type'], date: string, quantity: string | null, amount: number, extra: Partial<InvestmentActivity> = {}): InvestmentActivity {
  n += 1;
  return {
    id: `a${n}`,
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

describe('deriveLotsFifo', () => {
  it('sells the oldest lot first and records long and short term gains', () => {
    const result = deriveLotsFifo({
      ...base,
      activities: [
        act('buy', '2024-01-10', '10', -100_000),
        act('buy', '2025-06-01', '10', -150_000),
        act('sell', '2025-09-01', '15', 240_000),
      ],
    });
    expect(result.realized).toHaveLength(2);
    const [first, second] = result.realized;
    expect(first).toMatchObject({ acquiredOn: '2024-01-10', quantity: '10', costBasis: 100_000, term: 'long' });
    expect(second).toMatchObject({ acquiredOn: '2025-06-01', quantity: '5', costBasis: 75_000, term: 'short' });
    expect((first?.proceeds ?? 0) + (second?.proceeds ?? 0)).toBe(240_000);
    expect(result.lots).toHaveLength(1);
    expect(result.lots[0]).toMatchObject({ quantity: '5', costBasis: 75_000, source: 'derived' });
  });

  it('applies stock splits to open lots without changing cost basis', () => {
    const result = deriveLotsFifo({
      ...base,
      activities: [
        act('buy', '2023-05-10', '5', -142_500),
        act('split', '2024-06-10', null, 0, { splitRatio: '10' }),
        act('buy', '2025-04-08', '20', -192_600),
      ],
    });
    expect(result.lots.map((l) => l.quantity)).toEqual(['50', '20']);
    expect(result.lots.map((l) => l.costBasis)).toEqual([142_500, 192_600]);
  });

  it('sums dividends and warns when selling more than it holds', () => {
    const result = deriveLotsFifo({
      ...base,
      activities: [
        act('buy', '2024-01-01', '1', -10_000),
        act('dividend', '2024-03-01', null, 50),
        act('sell', '2024-04-01', '2', 30_000),
      ],
    });
    expect(result.dividends).toBe(50);
    expect(result.lots).toHaveLength(0);
    expect(result.warnings.join(' ')).toMatch(/more units/);
  });

  it('handles fractional crypto quantities exactly', () => {
    const result = deriveLotsFifo({
      ...base,
      activities: [
        act('buy', '2021-03-01', '0.15', -742_500),
        act('buy', '2024-11-12', '0.05', -441_000),
        act('sell', '2025-01-01', '0.1', 900_000),
      ],
    });
    expect(result.lots.map((l) => l.quantity)).toEqual(['0.05', '0.05']);
    expect(result.lots[0]?.costBasis).toBe(247_500);
  });
});

describe('holdingTerm and lotPerformance', () => {
  it('needs more than one year for long term', () => {
    expect(holdingTerm('2025-01-15', '2026-01-15')).toBe('short');
    expect(holdingTerm('2025-01-15', '2026-01-16')).toBe('long');
  });

  it('computes unrealized gain at a price', () => {
    const perf = lotPerformance(
      { id: 'l', holdingId: 'h', acquiredOn: '2024-01-01', quantity: '10', costBasis: 100_000, currency: 'USD', source: 'derived', externalId: null },
      '120',
      '2026-01-01',
    );
    expect(perf).toEqual({ marketValue: 120_000, gain: 20_000, gainPct: 0.2, term: 'long' });
  });
});
