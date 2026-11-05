import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { krakenAdapter, normalizeKrakenAsset } from '../src/adapters/kraken';
import { ConnectorRateLimitedError } from '../src/errors';
import { fakeFetch, fixture, makeConnection, makeCtx, type FakeCall } from './helpers/fakeFetch';
import {
  expectRepairOnExpiredToken,
  expectRepeatSyncIsQuiet,
  expectSyncShape,
} from './helpers/contract';

const SECRET = Buffer.from('demo-kraken-private-key-bytes-0001').toString('base64');
const SECRETS = { KRAKEN_API_KEY: 'demo-kraken-key', KRAKEN_API_SECRET: SECRET };
const H = 'api.kraken.com/0';

function routes(over: Record<string, unknown> = {}) {
  return {
    [`POST ${H}/private/BalanceEx`]: { json: fixture('kraken', 'balance.json') },
    [`GET ${H}/public/Ticker`]: { json: fixture('kraken', 'ticker.json') },
    [`POST ${H}/private/TradesHistory`]: (call: FakeCall) => ({
      json:
        new URLSearchParams(call.body ?? '').get('ofs') === '0'
          ? fixture('kraken', 'trades_page1.json')
          : fixture('kraken', 'trades_page2.json'),
    }),
    [`POST ${H}/private/Ledgers`]: { json: fixture('kraken', 'ledgers.json') },
    ...over,
  };
}
const ctxFor = (r = routes()) => makeCtx(SECRETS, fakeFetch(r));
const date = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);

describe('kraken adapter', () => {
  it('signs private calls: base64(HMAC-SHA512(secret, path + SHA256(nonce + body)))', async () => {
    const fetch = fakeFetch(routes());
    await krakenAdapter.sync(makeCtx(SECRETS, fetch), makeConnection('kraken'));
    const call = fetch.calls.find((c) => c.url.pathname === '/0/private/BalanceEx') as FakeCall;
    const nonce = new URLSearchParams(call.body).get('nonce') as string;
    const digest = createHash('sha256')
      .update(nonce + call.body)
      .digest();
    const expected = createHmac('sha512', Buffer.from(SECRET, 'base64'))
      .update(Buffer.concat([Buffer.from('/0/private/BalanceEx'), digest]))
      .digest('base64');
    expect(call.headers['API-Sign']).toBe(expected);
    expect(call.headers['API-Key']).toBe('demo-kraken-key');
  });

  it('normalises asset codes (XXBT, XBT.M, ZUSD)', () => {
    expect(normalizeKrakenAsset('XXBT')).toBe('BTC');
    expect(normalizeKrakenAsset('XBT.M')).toBe('BTC');
    expect(normalizeKrakenAsset('XETH')).toBe('ETH');
    expect(normalizeKrakenAsset('ZUSD')).toBe('USD');
    expect(normalizeKrakenAsset('DOT.S')).toBe('DOT');
    expect(normalizeKrakenAsset('XXDG')).toBe('DOGE');
  });

  it('builds a USD crypto account: staked and plain BTC merge, USD is cash, prices from Ticker', async () => {
    const result = await krakenAdapter.sync(ctxFor(), makeConnection('kraken'));
    await expectSyncShape(result);
    expect(result.holdings.map((h) => [h.symbol, h.quantity, h.price])).toEqual([
      ['BTC', '0.06', '68000.1'],
      ['ETH', '1.2', '2450.25'],
    ]);
    expect(result.accounts[0]).toMatchObject({
      type: 'crypto',
      currency: 'USD',
      balance: 408_001 + 294_030 + 25_040,
    });
  });

  it('signs trades (buy out incl. fee, sell in net of fee), pages by offset, and adds staking rewards', async () => {
    const fetch = fakeFetch(routes());
    const { activities } = await krakenAdapter.sync(
      makeCtx(SECRETS, fetch),
      makeConnection('kraken'),
    );
    const byId = new Map(activities.map((a) => [a.externalId, a]));
    expect(byId.get('TQ1AAA-AAAAA-AAAAAA')).toMatchObject({
      type: 'buy',
      amount: -122_305,
      fees: 305,
      quantity: '0.02',
      symbol: 'BTC',
      date: date(1773100000),
    });
    expect(byId.get('TQ3CCC-CCCCC-CCCCCC')).toMatchObject({
      type: 'sell',
      amount: 69_825,
      fees: 175,
    });
    expect(byId.get('ledger_L1AAA-AAAAA-AAAAAA')).toMatchObject({
      type: 'transfer_in',
      symbol: 'ETH',
      quantity: '0.0012',
    });
    expect(byId.has('ledger_L2BBB-BBBBB-BBBBBB')).toBe(false); // fiat deposit
    expect(byId.has('ledger_L3CCC-CCCCC-CCCCCC')).toBe(false); // staking wrapper move
    const offsets = fetch.calls
      .filter((c) => c.url.pathname.endsWith('TradesHistory'))
      .map((c) => new URLSearchParams(c.body).get('ofs'));
    expect(offsets).toEqual(['0', '2']);
  });

  it('derives lots from trades; the staked 0.01 BTC becomes an opening lot', async () => {
    const { store } = await expectRepeatSyncIsQuiet(krakenAdapter, () => ctxFor());
    const btc = store.securities.find((s) => s.symbol === 'BTC');
    const holding = store.holdings.find((h) => h.securityId === btc?.id);
    const lots = store.taxLots.filter((l) => l.holdingId === holding?.id);
    expect(lots.map((l) => l.quantity)).toEqual(['0.01', '0.04', '0.01']);
    expect(lots.reduce((n, l) => Number(l.quantity) + n, 0)).toBeCloseTo(0.06, 8);
  });

  it('reads errors from the body: invalid key means repair, rate limit means later', async () => {
    await expectRepairOnExpiredToken(krakenAdapter, () =>
      ctxFor(
        routes({ [`POST ${H}/private/BalanceEx`]: { json: fixture('kraken', 'error_key.json') } }),
      ),
    );
    await expect(
      krakenAdapter.sync(
        ctxFor(
          routes({
            [`POST ${H}/private/BalanceEx`]: { json: fixture('kraken', 'error_rate.json') },
          }),
        ),
        makeConnection('kraken'),
      ),
    ).rejects.toBeInstanceOf(ConnectorRateLimitedError);
  });
});
