import { describe, expect, it } from 'vitest';
import { MARKET_DATA_PROVIDERS, getAdapter } from '../src/adapters';
import { eodhdProvider, eodhdSymbol } from '../src/adapters/eodhd';
import { tiingoProvider } from '../src/adapters/tiingo';
import { twelveDataProvider } from '../src/adapters/twelve_data';
import { yahooFinanceProvider, yahooSymbol } from '../src/adapters/yahoo_finance';
import {
  MARKET_DATA_ORDER,
  SymbolNotFoundError,
  UnsupportedSymbolError,
  historyWithFallback,
  quoteWithFallback,
} from '../src/market';
import {
  ConnectorConfigError,
  ConnectorRateLimitedError,
  ConnectorRepairNeededError,
} from '../src/errors';
import { fakeFetch, fixture, makeConnection, makeCtx } from './helpers/fakeFetch';

const KEYS = {
  TWELVEDATA_API_KEY: 'td-key',
  TIINGO_API_TOKEN: 'tg-token',
  EODHD_API_KEY: 'eod-key',
};
const RELIANCE = { symbol: 'reliance', exchange: 'NSE' } as const;

describe('yahoo finance', () => {
  it('maps NSE, BSE and Toronto listings and crypto pairs to Yahoo symbols', () => {
    expect(yahooSymbol(RELIANCE)).toBe('RELIANCE.NS');
    expect(yahooSymbol({ symbol: 'TCS', exchange: 'BSE' })).toBe('TCS.BO');
    expect(yahooSymbol({ symbol: 'XIU', exchange: 'TSX' })).toBe('XIU.TO');
    expect(yahooSymbol({ symbol: 'btc', kind: 'crypto' })).toBe('BTC-USD');
    expect(yahooSymbol({ symbol: 'aapl' })).toBe('AAPL');
  });

  it('quotes an NSE share in rupees and needs no key', async () => {
    const fetch = fakeFetch({
      'GET query1.finance.yahoo.com/v8/finance/chart/RELIANCE.NS': {
        json: fixture('yahoo_finance', 'chart_reliance_quote.json'),
      },
    });
    const q = await yahooFinanceProvider.quote(makeCtx({}, fetch), RELIANCE);
    expect(q).toEqual({
      symbol: 'RELIANCE',
      exchange: 'NSE',
      price: '2510.75',
      currency: 'INR',
      asOf: '2026-11-04T12:00:00.000Z',
      source: 'yahoo_finance',
    });
    expect(fetch.calls[0]?.url.searchParams.get('range')).toBe('5d');
  });

  it('reads history, skipping days without a close', async () => {
    const fetch = fakeFetch({
      'GET query1.finance.yahoo.com/v8/finance/chart/RELIANCE.NS': {
        json: fixture('yahoo_finance', 'chart_reliance_history.json'),
      },
    });
    const rows = await yahooFinanceProvider.history(
      makeCtx({}, fetch),
      RELIANCE,
      '2026-11-01',
      '2026-11-04',
    );
    expect(rows.map((r) => [r.date, r.close])).toEqual([
      ['2026-11-01', '2480.5'],
      ['2026-11-03', '2500'],
      ['2026-11-04', '2510.75'],
    ]);
    expect(fetch.calls[0]?.url.searchParams.get('period1')).toBe(
      String(Date.parse('2026-11-01T00:00:00Z') / 1000),
    );
  });

  it('converts pence (GBp) to pounds', async () => {
    const fetch = fakeFetch({
      'GET query1.finance.yahoo.com/v8/finance/chart/VUSA.L': {
        json: fixture('yahoo_finance', 'chart_vusa_pence.json'),
      },
    });
    const q = await yahooFinanceProvider.quote(makeCtx({}, fetch), { symbol: 'VUSA.L' });
    expect(q).toMatchObject({ price: '98.5', currency: 'GBP' });
  });

  it('says not found for unknown symbols, whether Yahoo answers 404 or an error body', async () => {
    for (const status of [404, 200]) {
      const fetch = fakeFetch({
        'GET query1.finance.yahoo.com/v8/finance/chart/ZZZZ': {
          status,
          json: fixture('yahoo_finance', 'chart_not_found.json'),
        },
      });
      await expect(
        yahooFinanceProvider.quote(makeCtx({}, fetch), { symbol: 'ZZZZ' }),
      ).rejects.toBeInstanceOf(SymbolNotFoundError);
    }
  });

  it('as a connector it passes sync and health when Yahoo answers', async () => {
    const adapter = getAdapter('yahoo_finance')!;
    const ok = makeCtx(
      {},
      fakeFetch({
        'GET query1.finance.yahoo.com/v8/finance/chart/SPY': {
          json: fixture('yahoo_finance', 'chart_reliance_quote.json'),
        },
      }),
    );
    expect((await adapter.sync(ok, makeConnection('yahoo_finance'))).accounts).toEqual([]);
    expect(await adapter.checkHealth?.(ok, makeConnection('yahoo_finance'))).toBe('healthy');
  });
});

describe('twelve data', () => {
  const base = 'api.twelvedata.com';
  it('sends the key and the exchange for Indian listings', async () => {
    const fetch = fakeFetch({
      [`GET ${base}/quote`]: { json: fixture('twelve_data', 'quote_reliance.json') },
    });
    const q = await twelveDataProvider.quote(makeCtx(KEYS, fetch), RELIANCE);
    expect(q).toMatchObject({
      symbol: 'RELIANCE',
      exchange: 'NSE',
      price: '2510.75',
      currency: 'INR',
      source: 'twelve_data',
    });
    expect(fetch.calls[0]?.url.searchParams.get('exchange')).toBe('NSE');
    expect(fetch.calls[0]?.url.searchParams.get('apikey')).toBe('td-key');
  });

  it('reads a time series in date order', async () => {
    const fetch = fakeFetch({
      [`GET ${base}/time_series`]: { json: fixture('twelve_data', 'time_series_reliance.json') },
    });
    const rows = await twelveDataProvider.history(
      makeCtx(KEYS, fetch),
      RELIANCE,
      '2026-11-03',
      '2026-11-04',
    );
    expect(rows.map((r) => [r.date, r.close, r.currency])).toEqual([
      ['2026-11-03', '2500', 'INR'],
      ['2026-11-04', '2510.75', 'INR'],
    ]);
  });

  it('reads error codes from a 200 body', async () => {
    const answer = (file: string) =>
      makeCtx(KEYS, fakeFetch({ [`GET ${base}/quote`]: { json: fixture('twelve_data', file) } }));
    await expect(
      twelveDataProvider.quote(answer('error_key.json'), RELIANCE),
    ).rejects.toBeInstanceOf(ConnectorRepairNeededError);
    await expect(
      twelveDataProvider.quote(answer('error_limit.json'), RELIANCE),
    ).rejects.toBeInstanceOf(ConnectorRateLimitedError);
    await expect(
      twelveDataProvider.quote(answer('error_symbol.json'), RELIANCE),
    ).rejects.toBeInstanceOf(SymbolNotFoundError);
  });

  it('is a setup problem, not a repair, when the Worker has no key', async () => {
    await expect(
      twelveDataProvider.quote(makeCtx({}, fakeFetch({})), RELIANCE),
    ).rejects.toBeInstanceOf(ConnectorConfigError);
  });
});

describe('tiingo', () => {
  const base = 'api.tiingo.com';
  it('quotes the latest daily close in USD with the token header', async () => {
    const fetch = fakeFetch({
      [`GET ${base}/tiingo/daily/aapl/prices`]: { json: fixture('tiingo', 'prices_aapl.json') },
    });
    const q = await tiingoProvider.quote(makeCtx(KEYS, fetch), { symbol: 'AAPL' });
    expect(q).toMatchObject({
      price: '200.25',
      currency: 'USD',
      asOf: '2026-11-04T00:00:00.000Z',
      source: 'tiingo',
    });
    expect(fetch.calls[0]?.headers.Authorization).toBe('Token tg-token');
  });

  it('has no Indian listings and says so', async () => {
    await expect(
      tiingoProvider.quote(makeCtx(KEYS, fakeFetch({})), RELIANCE),
    ).rejects.toBeInstanceOf(UnsupportedSymbolError);
    await expect(
      tiingoProvider.history(
        makeCtx(KEYS, fakeFetch({})),
        { symbol: 'TCS', exchange: 'BSE' },
        '2026-01-01',
        '2026-01-02',
      ),
    ).rejects.toBeInstanceOf(UnsupportedSymbolError);
  });

  it('reads crypto history and unknown tickers', async () => {
    const fetch = fakeFetch({
      [`GET ${base}/tiingo/crypto/prices`]: { json: fixture('tiingo', 'crypto_btc.json') },
    });
    const rows = await tiingoProvider.history(
      makeCtx(KEYS, fetch),
      { symbol: 'BTC', kind: 'crypto' },
      '2026-11-03',
      '2026-11-04',
    );
    expect(rows.map((r) => [r.date, r.close])).toEqual([
      ['2026-11-03', '67900.5'],
      ['2026-11-04', '68000.1'],
    ]);
    expect(fetch.calls[0]?.url.searchParams.get('tickers')).toBe('btcusd');
    const missing = fakeFetch({
      [`GET ${base}/tiingo/daily/zzzz/prices`]: {
        status: 404,
        json: fixture('tiingo', 'error_not_found.json'),
      },
    });
    await expect(
      tiingoProvider.quote(makeCtx(KEYS, missing), { symbol: 'ZZZZ' }),
    ).rejects.toBeInstanceOf(SymbolNotFoundError);
  });

  it('asks for repair when the token is rejected', async () => {
    const fetch = fakeFetch({
      [`GET ${base}/tiingo/daily/aapl/prices`]: { status: 401, json: {} },
    });
    await expect(
      tiingoProvider.quote(makeCtx(KEYS, fetch), { symbol: 'AAPL' }),
    ).rejects.toBeInstanceOf(ConnectorRepairNeededError);
  });
});

describe('eodhd', () => {
  const base = 'eodhd.com/api';
  it('builds EODHD symbols for NSE, BSE, US and crypto', () => {
    expect(eodhdSymbol(RELIANCE)).toBe('RELIANCE.NSE');
    expect(eodhdSymbol({ symbol: 'tcs', exchange: 'BSE' })).toBe('TCS.BSE');
    expect(eodhdSymbol({ symbol: 'aapl' })).toBe('AAPL.US');
    expect(eodhdSymbol({ symbol: 'btc', kind: 'crypto' })).toBe('BTC-USD.CC');
  });

  it('quotes in rupees for NSE and reads history', async () => {
    const fetch = fakeFetch({
      [`GET ${base}/real-time/RELIANCE.NSE`]: { json: fixture('eodhd', 'realtime_reliance.json') },
      [`GET ${base}/eod/RELIANCE.NSE`]: { json: fixture('eodhd', 'eod_reliance.json') },
    });
    const q = await eodhdProvider.quote(makeCtx(KEYS, fetch), RELIANCE);
    expect(q).toMatchObject({
      price: '2510.75',
      currency: 'INR',
      asOf: '2026-11-04T12:00:00.000Z',
      source: 'eodhd',
    });
    expect(fetch.calls[0]?.url.searchParams.get('api_token')).toBe('eod-key');
    const rows = await eodhdProvider.history(
      makeCtx(KEYS, fetch),
      RELIANCE,
      '2026-11-03',
      '2026-11-04',
    );
    expect(rows.map((r) => [r.date, r.close, r.currency])).toEqual([
      ['2026-11-03', '2500', 'INR'],
      ['2026-11-04', '2510.75', 'INR'],
    ]);
  });

  it('asks for repair on 401', async () => {
    const fetch = fakeFetch({ [`GET ${base}/real-time/AAPL.US`]: { status: 401, json: {} } });
    await expect(
      eodhdProvider.quote(makeCtx(KEYS, fetch), { symbol: 'AAPL' }),
    ).rejects.toBeInstanceOf(ConnectorRepairNeededError);
  });
});

describe('market data fallback (Yahoo, then Twelve Data, Tiingo, EODHD)', () => {
  it("keeps the brief's order", () => {
    expect(MARKET_DATA_PROVIDERS.map((p) => p.id)).toEqual([...MARKET_DATA_ORDER]);
  });

  it('uses Yahoo when it answers', async () => {
    const ctx = makeCtx(
      KEYS,
      fakeFetch({
        'GET query1.finance.yahoo.com/v8/finance/chart/RELIANCE.NS': {
          json: fixture('yahoo_finance', 'chart_reliance_quote.json'),
        },
      }),
    );
    const r = await quoteWithFallback(ctx, MARKET_DATA_PROVIDERS, RELIANCE);
    expect(r.value?.source).toBe('yahoo_finance');
    expect(r.attempts).toEqual([{ provider: 'yahoo_finance', outcome: 'ok' }]);
  });

  it('falls through Yahoo (rate limited) and a missing Tiingo coverage to the next provider that answers', async () => {
    const ctx = makeCtx(
      { EODHD_API_KEY: 'k' },
      fakeFetch({
        'GET query1.finance.yahoo.com/v8/finance/chart/RELIANCE.NS': { status: 429, json: {} },
        'GET eodhd.com/api/real-time/RELIANCE.NSE': {
          json: fixture('eodhd', 'realtime_reliance.json'),
        },
      }),
    );
    const r = await quoteWithFallback(ctx, MARKET_DATA_PROVIDERS, RELIANCE);
    expect(r.value?.source).toBe('eodhd');
    expect(r.attempts.map((a) => [a.provider, a.outcome])).toEqual([
      ['yahoo_finance', 'error'],
      ['twelve_data', 'no_key'],
      ['tiingo', 'unsupported'],
      ['eodhd', 'ok'],
    ]);
  });

  it('skips Tiingo for Indian symbols and records key problems', async () => {
    const ctx = makeCtx(
      KEYS,
      fakeFetch({
        'GET query1.finance.yahoo.com/v8/finance/chart/RELIANCE.NS': {
          status: 404,
          json: fixture('yahoo_finance', 'chart_not_found.json'),
        },
        'GET api.twelvedata.com/quote': { json: fixture('twelve_data', 'error_key.json') },
        'GET eodhd.com/api/real-time/RELIANCE.NSE': {
          json: fixture('eodhd', 'realtime_reliance.json'),
        },
      }),
    );
    const r = await quoteWithFallback(ctx, MARKET_DATA_PROVIDERS, RELIANCE);
    expect(r.attempts.map((a) => [a.provider, a.outcome])).toEqual([
      ['yahoo_finance', 'not_found'],
      ['twelve_data', 'key_rejected'],
      ['tiingo', 'unsupported'],
      ['eodhd', 'ok'],
    ]);
  });

  it('returns null with every reason when no provider can answer, and never throws', async () => {
    const r = await quoteWithFallback(
      makeCtx(
        {},
        fakeFetch({
          'GET query1.finance.yahoo.com/v8/finance/chart/ZZZZ': { status: 404, json: {} },
        }),
      ),
      MARKET_DATA_PROVIDERS,
      { symbol: 'ZZZZ' },
    );
    expect(r.value).toBeNull();
    expect(r.attempts).toHaveLength(4);
  });

  it('falls back for history and treats an empty series as no answer', async () => {
    const empty = {
      chart: {
        result: [
          {
            meta: { currency: 'INR', symbol: 'X' },
            timestamp: [],
            indicators: { quote: [{ close: [] }] },
          },
        ],
        error: null,
      },
    };
    const ctx = makeCtx(
      KEYS,
      fakeFetch({
        'GET query1.finance.yahoo.com/v8/finance/chart/RELIANCE.NS': { json: empty },
        'GET api.twelvedata.com/time_series': {
          json: fixture('twelve_data', 'time_series_reliance.json'),
        },
      }),
    );
    const r = await historyWithFallback(
      ctx,
      MARKET_DATA_PROVIDERS,
      RELIANCE,
      '2026-11-03',
      '2026-11-04',
    );
    expect(r.value).toHaveLength(2);
    expect(r.attempts.map((a) => [a.provider, a.outcome])).toEqual([
      ['yahoo_finance', 'not_found'],
      ['twelve_data', 'ok'],
    ]);
  });
});
