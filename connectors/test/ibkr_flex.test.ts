import { describe, expect, it, vi } from 'vitest';
import { ibkrFlexAdapter } from '../src/adapters/ibkr_flex';
import { ConnectorRateLimitedError } from '../src/errors';
import { httpRuntime } from '../src/http';
import { parseXml } from '../src/util/xml';
import { fakeFetch, fixture, makeConnection, makeCtx } from './helpers/fakeFetch';
import {
  expectRepairOnExpiredToken,
  expectRepeatSyncIsQuiet,
  expectSyncShape,
} from './helpers/contract';

const SECRETS = { IBKR_FLEX_TOKEN: 'demo-flex-token', IBKR_FLEX_QUERY_ID: '424242' };
const H = 'ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService';

function routes(over: Record<string, unknown> = {}) {
  return {
    [`GET ${H}/SendRequest`]: { text: fixture<string>('ibkr_flex', 'send_ok.xml') },
    [`GET ${H}/GetStatement`]: { text: fixture<string>('ibkr_flex', 'statement.xml') },
    ...over,
  };
}
const ctxFor = (r = routes()) => makeCtx(SECRETS, fakeFetch(r));

describe('ibkr flex adapter', () => {
  it('requests a report with the token and query id, then fetches it by reference code', async () => {
    const fetch = fakeFetch(routes());
    await ibkrFlexAdapter.sync(makeCtx(SECRETS, fetch), makeConnection('ibkr_flex'));
    expect(fetch.calls[0]?.url.searchParams.get('t')).toBe('demo-flex-token');
    expect(fetch.calls[0]?.url.searchParams.get('q')).toBe('424242');
    expect(fetch.calls[1]?.url.searchParams.get('q')).toBe('1234567890');
    expect(fetch.calls[1]?.url.searchParams.get('v')).toBe('3');
  });

  it('waits while the statement is being generated', async () => {
    let n = 0;
    const sleep = vi.spyOn(httpRuntime, 'sleep');
    const r = routes({
      [`GET ${H}/GetStatement`]: () =>
        ++n < 3
          ? { text: fixture<string>('ibkr_flex', 'get_wait.xml') }
          : { text: fixture<string>('ibkr_flex', 'statement.xml') },
    });
    const result = await ibkrFlexAdapter.sync(ctxFor(r), makeConnection('ibkr_flex'));
    expect(n).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(result.accounts).toHaveLength(1);
    sleep.mockRestore();
  });

  it('builds the account balance from position value plus cash', async () => {
    const result = await ibkrFlexAdapter.sync(ctxFor(), makeConnection('ibkr_flex'));
    await expectSyncShape(result);
    expect(result.accounts[0]).toMatchObject({
      externalId: 'U1234567',
      type: 'brokerage',
      currency: 'USD',
      balance: 1_642_000 + 125_050,
      mask: '4567',
    });
  });

  it('reads positions: LOT rows become broker tax lots, options are skipped, entities decoded', async () => {
    const { holdings } = await ibkrFlexAdapter.sync(ctxFor(), makeConnection('ibkr_flex'));
    expect(holdings.map((h) => h.symbol)).toEqual(['VTI', 'MSFT']);
    const vti = holdings.find((h) => h.symbol === 'VTI');
    expect(vti).toMatchObject({
      quantity: '30',
      price: '280.5',
      costBasis: 705_000,
      exchange: 'ARCA',
      securityType: 'etf',
    });
    expect(vti?.lots).toEqual([
      {
        externalId: '900001',
        acquiredOn: '2025-01-15',
        quantity: '10',
        costBasis: 220_000,
        currency: 'USD',
      },
      {
        externalId: '900002',
        acquiredOn: '2025-09-02',
        quantity: '20',
        costBasis: 485_000,
        currency: 'USD',
      },
    ]);
    const msft = holdings.find((h) => h.symbol === 'MSFT');
    expect(msft?.lots).toBeNull();
    expect(msft?.name).toBe('EXAMPLE SOFTWARE & SERVICES');
  });

  it('signs activity: netCash for trades, cash transactions by type', async () => {
    const { activities } = await ibkrFlexAdapter.sync(ctxFor(), makeConnection('ibkr_flex'));
    const byId = new Map(activities.map((a) => [a.externalId, a]));
    expect(byId.get('ibkr_7001')).toMatchObject({
      type: 'buy',
      amount: -360_100,
      fees: 100,
      quantity: '10',
      date: '2025-03-10',
    });
    expect(byId.get('ibkr_7003')).toMatchObject({ type: 'sell', amount: 122_900, quantity: '3' });
    expect(byId.has('ibkr_7004')).toBe(false); // option
    expect(byId.get('ibkr_cash_8001')).toMatchObject({ type: 'dividend', amount: 960 });
    expect(byId.get('ibkr_cash_8002')).toMatchObject({ type: 'fee', amount: -144 });
    expect(byId.get('ibkr_cash_8003')).toMatchObject({ type: 'contribution', amount: 50_000 });
    expect(byId.get('ibkr_cash_8004')).toMatchObject({ type: 'interest', amount: 125 });
  });

  it('keeps broker lots for VTI, derives MSFT lots from trades, and is quiet on repeat', async () => {
    const { store } = await expectRepeatSyncIsQuiet(ibkrFlexAdapter, () => ctxFor());
    const holdingOf = (sym: string) =>
      store.holdings.find(
        (h) => h.securityId === store.securities.find((s) => s.symbol === sym)?.id,
      );
    const vtiLots = store.taxLots.filter((l) => l.holdingId === holdingOf('VTI')?.id);
    expect(vtiLots.map((l) => [l.source, l.quantity, l.costBasis])).toEqual([
      ['broker', '10', 220_000],
      ['broker', '20', 485_000],
    ]);
    const msftLots = store.taxLots.filter((l) => l.holdingId === holdingOf('MSFT')?.id);
    expect(msftLots.map((l) => [l.source, l.acquiredOn, l.quantity, l.costBasis])).toEqual([
      ['derived', '2025-03-10', '7', 252_070],
      ['derived', '2025-07-21', '5', 190_100],
    ]);
  });

  it('asks for repair on an expired token and treats too-many-requests as try later', async () => {
    await expectRepairOnExpiredToken(ibkrFlexAdapter, () =>
      ctxFor(
        routes({
          [`GET ${H}/SendRequest`]: { text: fixture<string>('ibkr_flex', 'send_expired.xml') },
        }),
      ),
    );
    await expect(
      ibkrFlexAdapter.sync(
        ctxFor(
          routes({
            [`GET ${H}/SendRequest`]: { text: fixture<string>('ibkr_flex', 'send_busy.xml') },
          }),
        ),
        makeConnection('ibkr_flex'),
      ),
    ).rejects.toBeInstanceOf(ConnectorRateLimitedError);
  });
});

describe('xml reader', () => {
  it('parses attributes, entities, CDATA and self-closing tags', () => {
    const doc = parseXml(
      '<?xml version="1.0"?><a x="1 &amp; 2"><b y=\'z\'/><c><![CDATA[<raw>]]></c></a>',
    );
    expect(doc.attrs.x).toBe('1 & 2');
    expect(doc.children[0]?.attrs.y).toBe('z');
    expect(doc.children[1]?.text).toBe('<raw>');
  });
  it('rejects mismatched tags', () => {
    expect(() => parseXml('<a><b></a>')).toThrow();
  });
});
