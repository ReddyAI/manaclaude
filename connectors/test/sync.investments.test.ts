import { describe, expect, it } from 'vitest';
import type {
  Holding,
  InvestmentActivity,
  ProviderActivity,
  ProviderHolding,
  Security,
  TaxLot,
} from '@manaclaude/shared';
import { planInvestmentSync, type InvestmentSyncInput } from '../src/sync';

const NOW = '2026-11-05T12:00:00.000Z';
const ACCOUNTS = new Map([['ext_brk', 'acc_brk']]);
let n = 0;
const newId = (k: string) => `${k}_n${++n}`;

const holding = (over: Partial<ProviderHolding> = {}): ProviderHolding => ({
  accountExternalId: 'ext_brk',
  symbol: 'MSFT',
  name: 'Example Software',
  securityType: 'equity',
  exchange: 'NASDAQ',
  quantity: '10',
  price: '400',
  currency: 'USD',
  costBasis: 360_000,
  lots: null,
  ...over,
});
const activity = (over: Partial<ProviderActivity> = {}): ProviderActivity => ({
  externalId: 'a1',
  accountExternalId: 'ext_brk',
  symbol: 'MSFT',
  type: 'buy',
  date: '2025-03-10',
  quantity: '10',
  price: '360',
  amount: -360_000,
  fees: 0,
  currency: 'USD',
  splitRatio: null,
  ...over,
});

type State = {
  securities: Security[];
  holdings: Holding[];
  taxLots: TaxLot[];
  activities: InvestmentActivity[];
};

/** `holdings` and `activities` are what the provider sends; `state` is what is already stored. */
function plan(
  over: Partial<Pick<InvestmentSyncInput, 'completeAccounts' | 'now'>> & {
    state?: State;
    holdings?: ProviderHolding[];
    activities?: ProviderActivity[];
  } = {},
) {
  const { holdings, activities, state, ...rest } = over;
  return planInvestmentSync({
    connectionId: 'conn_1',
    accounts: ACCOUNTS,
    securities: state?.securities ?? [],
    holdings: state?.holdings ?? [],
    taxLots: state?.taxLots ?? [],
    activities: state?.activities ?? [],
    result: { holdings: holdings ?? [], activities: activities ?? [] },
    now: NOW,
    newId,
    ...rest,
  });
}

/** Apply a plan to arrays, like the backend would. */
function apply(out: ReturnType<typeof plan>, state: State): State {
  const next = {
    securities: [...state.securities, ...out.securityInserts],
    holdings: [
      ...state.holdings
        .filter((h) => !out.holdingRemovals.includes(h.id))
        .map((h) => ({ ...h, ...(out.holdingUpdates.find((u) => u.id === h.id)?.changes ?? {}) })),
      ...out.holdingInserts,
    ],
    taxLots: [
      ...state.taxLots
        .filter((l) => !out.lotRemovals.includes(l.id))
        .map((l) => ({ ...l, ...(out.lotUpdates.find((u) => u.id === l.id)?.changes ?? {}) })),
      ...out.lotInserts,
    ],
    activities: [
      ...state.activities.map((a) => ({
        ...a,
        ...(out.activityUpdates.find((u) => u.id === a.id)?.changes ?? {}),
      })),
      ...out.activityInserts,
    ],
  };
  return next;
}
const empty: State = { securities: [], holdings: [], taxLots: [], activities: [] };

describe('investment sync: holdings', () => {
  it('creates the security and the holding with market value and source', () => {
    const out = plan({ holdings: [holding()] });
    expect(out.securityInserts[0]).toMatchObject({
      symbol: 'MSFT',
      exchange: 'NASDAQ',
      type: 'equity',
      assetClass: 'us_stocks',
      isBenchmark: false,
    });
    expect(out.holdingInserts[0]).toMatchObject({
      accountId: 'acc_brk',
      quantity: '10',
      price: '400',
      marketValue: 400_000,
      costBasis: 360_000,
      source: 'connector',
    });
  });

  it('puts Indian securities in the india_stocks class', () => {
    const out = plan({
      holdings: [holding({ symbol: 'RELIANCE', exchange: 'NSE', currency: 'INR' })],
    });
    expect(out.securityInserts[0]?.assetClass).toBe('india_stocks');
  });

  it('updates quantity, price and value of a known holding without inserting again', () => {
    const first = apply(plan({ holdings: [holding()] }), empty);
    const second = plan({ state: first, holdings: [holding({ quantity: '12', price: '410' })] });
    expect(second.holdingInserts).toEqual([]);
    expect(second.securityInserts).toEqual([]);
    expect(second.holdingUpdates[0]?.changes).toMatchObject({
      quantity: '12',
      price: '410',
      marketValue: 492_000,
    });
  });

  it('removes a holding that is gone from a complete account (sold out) with its lots', () => {
    const first = apply(plan({ holdings: [holding()] }), empty);
    expect(first.taxLots.length).toBeGreaterThan(0);
    const second = plan({ state: first, holdings: [], completeAccounts: new Set(['ext_brk']) });
    expect(second.holdingRemovals).toEqual([first.holdings[0]?.id]);
    expect(second.lotRemovals.length).toBe(first.taxLots.length);
  });

  it('leaves holdings alone for accounts the result says nothing about', () => {
    const first = apply(plan({ holdings: [holding()] }), empty);
    expect(plan({ state: first, holdings: [] }).holdingRemovals).toEqual([]);
  });

  it('does not touch manual holdings', () => {
    const manual: Holding = {
      id: 'h_manual',
      accountId: 'acc_brk',
      securityId: 'sec_x',
      quantity: '1',
      price: '1',
      priceAsOf: NOW,
      marketValue: 1,
      costBasis: null,
      currency: 'USD',
      source: 'manual',
    };
    const out2 = planInvestmentSync({
      connectionId: 'c',
      accounts: ACCOUNTS,
      securities: [],
      holdings: [manual],
      taxLots: [],
      activities: [],
      result: { holdings: [], activities: [] },
      completeAccounts: new Set(['ext_brk']),
      now: NOW,
      newId,
    });
    expect(out2.holdingRemovals).toEqual([]);
  });
});

describe('investment sync: lots', () => {
  it('takes broker lots as they are and matches them again on the next sync', () => {
    const lots = [
      {
        externalId: 'l1',
        acquiredOn: '2025-01-15',
        quantity: '4',
        costBasis: 140_000,
        currency: 'USD',
      },
      {
        externalId: 'l2',
        acquiredOn: '2025-09-02',
        quantity: '6',
        costBasis: 220_000,
        currency: 'USD',
      },
    ];
    const first = apply(plan({ holdings: [holding({ lots })] }), empty);
    expect(first.taxLots.map((l) => [l.source, l.externalId, l.quantity, l.costBasis])).toEqual([
      ['broker', 'l1', '4', 140_000],
      ['broker', 'l2', '6', 220_000],
    ]);
    expect(first.holdings[0]?.costBasis).toBe(360_000); // sum of broker lots wins over the summary
    const second = plan({
      state: first,
      holdings: [holding({ lots: [{ ...lots[0]!, quantity: '3', costBasis: 105_000 }, lots[1]!] })],
    });
    expect(second.lotInserts).toEqual([]);
    expect(second.lotRemovals).toEqual([]);
    expect(second.lotUpdates).toHaveLength(1);
    expect(second.lotUpdates[0]?.changes).toMatchObject({ quantity: '3', costBasis: 105_000 });
  });

  it('removes a broker lot that the broker no longer lists', () => {
    const lots = [
      {
        externalId: 'l1',
        acquiredOn: '2025-01-15',
        quantity: '4',
        costBasis: 140_000,
        currency: 'USD',
      },
      {
        externalId: 'l2',
        acquiredOn: '2025-09-02',
        quantity: '6',
        costBasis: 220_000,
        currency: 'USD',
      },
    ];
    const first = apply(plan({ holdings: [holding({ lots })] }), empty);
    const second = plan({ state: first, holdings: [holding({ quantity: '6', lots: [lots[1]!] })] });
    expect(second.lotRemovals).toHaveLength(1);
  });

  it('derives FIFO lots from buy and sell activities when the broker sends none', () => {
    const out = plan({
      holdings: [holding({ quantity: '12', costBasis: 442_000 })],
      activities: [
        activity({ externalId: 'b1', date: '2025-03-10', quantity: '10', amount: -360_000 }),
        activity({ externalId: 'b2', date: '2025-07-21', quantity: '5', amount: -190_000 }),
        activity({
          externalId: 's1',
          type: 'sell',
          date: '2026-02-02',
          quantity: '3',
          amount: 123_000,
        }),
      ],
    });
    expect(out.lotInserts.map((l) => [l.source, l.acquiredOn, l.quantity, l.costBasis])).toEqual([
      ['derived', '2025-03-10', '7', 252_000],
      ['derived', '2025-07-21', '5', 190_000],
    ]);
    expect(out.activityInserts).toHaveLength(3);
  });

  it('covers a position larger than the history with one opening lot at the broker cost, and keeps its date later', () => {
    const first = apply(
      plan({
        holdings: [holding({ quantity: '12', costBasis: 500_000 })],
        activities: [
          activity({ externalId: 'b1', date: '2026-01-05', quantity: '4', amount: -160_000 }),
        ],
      }),
      empty,
    );
    const opening = first.taxLots.find((l) => l.externalId === 'opening_balance');
    expect(opening).toMatchObject({
      quantity: '8',
      costBasis: 340_000,
      acquiredOn: '2026-01-05',
      source: 'derived',
    });
    const later = plan({
      state: first,
      now: '2026-12-01T12:00:00.000Z',
      holdings: [holding({ quantity: '12', costBasis: 500_000 })],
    });
    expect(later.lotInserts).toEqual([]);
    expect(later.lotUpdates).toEqual([]);
  });

  it('trims the oldest lots when the history holds more than the broker reports', () => {
    const out = plan({
      holdings: [holding({ quantity: '8', costBasis: 300_000 })],
      activities: [
        activity({ externalId: 'b1', date: '2025-03-10', quantity: '10', amount: -360_000 }),
      ],
    });
    expect(out.lotInserts.map((l) => l.quantity)).toEqual(['8']);
    expect(out.lotInserts[0]?.costBasis).toBe(288_000);
    expect(out.warnings.join(' ')).toMatch(/trimmed/);
  });

  it('warns and uses a zero cost for coins received with no price and no broker cost', () => {
    const out = plan({
      holdings: [
        holding({
          symbol: 'BTC',
          securityType: 'crypto',
          exchange: 'CRYPTO',
          quantity: '0.5',
          price: '60000',
          costBasis: null,
        }),
      ],
      activities: [
        activity({
          externalId: 't1',
          symbol: 'BTC',
          type: 'transfer_in',
          quantity: '0.5',
          price: null,
          amount: 0,
        }),
      ],
    });
    expect(out.lotInserts[0]).toMatchObject({ quantity: '0.5', costBasis: 0 });
    expect(out.warnings.join(' ')).toMatch(/no cost basis/);
  });
});

describe('investment sync: activities', () => {
  it('dedupes by provider id across syncs and updates a changed row', () => {
    const first = apply(plan({ holdings: [holding()], activities: [activity()] }), empty);
    const same = plan({ state: first, holdings: [holding()], activities: [activity()] });
    expect(same.activityInserts).toEqual([]);
    expect(same.activityUpdates).toEqual([]);
    const changed = plan({
      state: first,
      holdings: [holding()],
      activities: [activity({ amount: -360_100, fees: 100 })],
    });
    expect(changed.activityUpdates[0]?.changes).toMatchObject({ amount: -360_100, fees: 100 });
  });

  it('two identical buys with different ids are both kept', () => {
    const out = plan({
      holdings: [holding({ quantity: '20' })],
      activities: [activity({ externalId: 'x1' }), activity({ externalId: 'x2' })],
    });
    expect(out.activityInserts).toHaveLength(2);
    expect(out.lotInserts.map((l) => l.quantity)).toEqual(['10', '10']);
  });

  it('creates a security for an activity whose holding is gone (fully sold)', () => {
    const out = plan({
      activities: [activity({ symbol: 'OLD', type: 'sell', quantity: '5', amount: 5000 })],
    });
    expect(out.securityInserts.map((s) => s.symbol)).toEqual(['OLD']);
  });

  it('keeps cash-only activities with no security', () => {
    const out = plan({
      activities: [
        activity({
          externalId: 'c1',
          symbol: null,
          type: 'contribution',
          quantity: null,
          price: null,
          amount: 50_000,
        }),
      ],
    });
    expect(out.activityInserts[0]).toMatchObject({
      securityId: null,
      type: 'contribution',
      amount: 50_000,
    });
    expect(out.securityInserts).toEqual([]);
  });

  it('does not change the rows it was given', () => {
    const first = apply(plan({ holdings: [holding()], activities: [activity()] }), empty);
    const snapshot = JSON.stringify(first.activities);
    plan({ state: first, holdings: [holding()], activities: [activity({ amount: -1 })] });
    expect(JSON.stringify(first.activities)).toBe(snapshot);
  });
});
