import { beforeAll, describe, expect, it } from 'vitest';
import { coinbaseAdapter } from '../src/adapters/coinbase';
import { fromBase64, parsePem, signJwt, toBase64, toBase64Url } from '../src/util/crypto';
import { fakeFetch, fixture, makeConnection, makeCtx, type FakeCall } from './helpers/fakeFetch';
import {
  expectRepairOnExpiredToken,
  expectRepeatSyncIsQuiet,
  expectSyncShape,
} from './helpers/contract';

const H = 'api.coinbase.com/v2';

function pem(label: string, der: Uint8Array): string {
  const b64 = toBase64(der).replace(/(.{64})/g, '$1\n');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----`;
}

async function ecKey(): Promise<{ pkcs8Pem: string; sec1Pem: string; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  // Find the ECPrivateKey inside PKCS8 (OCTET STRING 109 bytes -> SEQUENCE 107 bytes).
  let at = 0;
  for (let i = 0; i < pkcs8.length - 3; i++) {
    if (
      pkcs8[i] === 0x04 &&
      pkcs8[i + 1] === 0x6d &&
      pkcs8[i + 2] === 0x30 &&
      pkcs8[i + 3] === 0x6b
    )
      at = i + 2;
  }
  const inner = pkcs8.slice(at);
  const priv = inner.slice(7, 39);
  const pub = inner.slice(inner.length - 65);
  // The SEC1 form Coinbase hands out: version, private key, curve parameters, public key.
  const params = [0xa0, 0x0a, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
  const body = [
    0x02,
    0x01,
    0x01,
    0x04,
    0x20,
    ...priv,
    ...params,
    0xa1,
    0x44,
    0x03,
    0x42,
    0x00,
    ...pub,
  ];
  const sec1 = new Uint8Array([0x30, body.length, ...body]);
  return {
    pkcs8Pem: pem('PRIVATE KEY', pkcs8),
    sec1Pem: pem('EC PRIVATE KEY', sec1),
    publicKey: pair.publicKey,
  };
}

async function verifyEs256(jwt: string, publicKey: CryptoKey): Promise<boolean> {
  const [h, p, s] = jwt.split('.') as [string, string, string];
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    fromBase64(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
}

describe('coinbase JWT signing', () => {
  it('signs ES256 with a PKCS8 PEM key', async () => {
    const { pkcs8Pem, publicKey } = await ecKey();
    const jwt = await signJwt(
      pkcs8Pem,
      { kid: 'organizations/o/apiKeys/k' },
      { sub: 'k', uri: 'GET api.coinbase.com/v2/user' },
    );
    const header = JSON.parse(atob(jwt.split('.')[0]!.replace(/-/g, '+').replace(/_/g, '/')));
    expect(header).toMatchObject({ alg: 'ES256', typ: 'JWT', kid: 'organizations/o/apiKeys/k' });
    expect(await verifyEs256(jwt, publicKey)).toBe(true);
  });

  it('accepts the SEC1 "EC PRIVATE KEY" form Coinbase hands out', async () => {
    const { sec1Pem, publicKey } = await ecKey();
    expect(parsePem(sec1Pem).label).toBe('EC PRIVATE KEY');
    const jwt = await signJwt(sec1Pem, { kid: 'k' }, { sub: 'k' });
    expect(await verifyEs256(jwt, publicKey)).toBe(true);
  });

  it('signs EdDSA with a base64 Ed25519 secret', async () => {
    const pair = (await crypto.subtle.generateKey('Ed25519', true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
    const seed = pkcs8.slice(-32);
    const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    const secret = toBase64(new Uint8Array([...seed, ...pub]));
    const jwt = await signJwt(secret, { kid: 'k' }, { sub: 'k' });
    const [h, p, s] = jwt.split('.') as [string, string, string];
    expect(JSON.parse(atob(h.replace(/-/g, '+').replace(/_/g, '/'))).alg).toBe('EdDSA');
    expect(
      await crypto.subtle.verify(
        'Ed25519',
        pair.publicKey,
        fromBase64(s),
        new TextEncoder().encode(`${h}.${p}`),
      ),
    ).toBe(true);
    expect(toBase64Url(new Uint8Array([251, 255]))).toBe('-_8');
  });
});

describe('coinbase adapter', () => {
  let S: Record<string, string> = {};
  beforeAll(async () => {
    const { pkcs8Pem } = await ecKey();
    S = { COINBASE_API_KEY: 'organizations/demo/apiKeys/key1', COINBASE_API_SECRET: pkcs8Pem };
  });
  function routes(over: Record<string, unknown> = {}) {
    return {
      [`GET ${H}/user`]: { json: fixture('coinbase', 'user.json') },
      [`GET ${H}/accounts`]: (call: FakeCall) => ({
        json: call.url.searchParams.get('starting_after')
          ? fixture('coinbase', 'accounts_page2.json')
          : fixture('coinbase', 'accounts_page1.json'),
      }),
      [`GET ${H}/prices/BTC-USD/spot`]: { json: fixture('coinbase', 'spot_btc.json') },
      [`GET ${H}/prices/ETH-USD/spot`]: { json: fixture('coinbase', 'spot_eth.json') },
      [`GET ${H}/accounts/wallet-btc/buys`]: { json: fixture('coinbase', 'buys_btc.json') },
      [`GET ${H}/accounts/wallet-btc/sells`]: { json: fixture('coinbase', 'sells_btc.json') },
      [`GET ${H}/accounts/wallet-btc/transactions`]: {
        json: fixture('coinbase', 'transactions_btc.json'),
      },
      [`GET ${H}/accounts/wallet-eth/buys`]: { json: fixture('coinbase', 'empty_list.json') },
      [`GET ${H}/accounts/wallet-eth/sells`]: { json: fixture('coinbase', 'empty_list.json') },
      [`GET ${H}/accounts/wallet-eth/transactions`]: {
        json: fixture('coinbase', 'transactions_eth.json'),
      },
      [`GET ${H}/accounts/wallet-doge/buys`]: { json: fixture('coinbase', 'empty_list.json') },
      [`GET ${H}/accounts/wallet-doge/sells`]: { json: fixture('coinbase', 'empty_list.json') },
      [`GET ${H}/accounts/wallet-doge/transactions`]: {
        json: fixture('coinbase', 'empty_list.json'),
      },
      ...over,
    };
  }

  it('sends a bearer JWT whose uri names the method and path', async () => {
    const fetch = fakeFetch(routes());
    await coinbaseAdapter.sync(makeCtx(S, fetch), makeConnection('coinbase'));
    const auth = fetch.calls[0]?.headers.Authorization ?? '';
    const payload = JSON.parse(
      atob(auth.replace('Bearer ', '').split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')),
    );
    expect(payload).toMatchObject({
      iss: 'cdp',
      sub: 'organizations/demo/apiKeys/key1',
      uri: 'GET api.coinbase.com/v2/user',
    });
    expect(payload.exp - payload.nbf).toBe(120);
  });

  it('builds one crypto account with a holding per funded coin wallet (paged) and USD cash', async () => {
    const result = await coinbaseAdapter.sync(
      makeCtx(S, fakeFetch(routes())),
      makeConnection('coinbase'),
    );
    await expectSyncShape(result);
    expect(result.holdings.map((h) => [h.symbol, h.quantity, h.price, h.exchange])).toEqual([
      ['BTC', '0.05', '68000.5', 'CRYPTO'],
      ['ETH', '1.2', '2450.25', 'CRYPTO'],
    ]);
    // 0.05 x 68000.50 = 3400.025 -> 3400.03 (half up), 1.2 x 2450.25 = 2940.30, cash 125.40.
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]).toMatchObject({
      type: 'crypto',
      currency: 'USD',
      balance: 340_003 + 294_030 + 12_540,
    });
  });

  it('signs history: buys out including fee, sells in net of fee, rewards as income', async () => {
    const { activities } = await coinbaseAdapter.sync(
      makeCtx(S, fakeFetch(routes())),
      makeConnection('coinbase'),
    );
    const byId = new Map(activities.map((a) => [a.externalId, a]));
    expect(byId.get('buy-1')).toMatchObject({
      type: 'buy',
      amount: -123_650,
      fees: 3_650,
      quantity: '0.02',
      symbol: 'BTC',
    });
    expect(byId.get('sell-1')).toMatchObject({ type: 'sell', amount: 88_000, quantity: '0.01' });
    expect(byId.get('tx-stake-1')).toMatchObject({
      type: 'dividend',
      amount: 1_029,
      symbol: 'ETH',
    });
    expect(byId.get('tx-send-1')).toMatchObject({ type: 'transfer_in', amount: 0 });
    expect(byId.get('tx-send-2')).toMatchObject({ type: 'transfer_in' });
    expect(byId.has('tx-buy-1')).toBe(false); // buys come from the buys endpoint, not twice
  });

  it('derives lots from buys, sells and transfers, matching the held quantity, and stays quiet on repeat', async () => {
    const { store } = await expectRepeatSyncIsQuiet(coinbaseAdapter, () =>
      makeCtx(S, fakeFetch(routes())),
    );
    const lotsOf = (sym: string) => {
      const sec = store.securities.find((x) => x.symbol === sym);
      const holding = store.holdings.find((h) => h.securityId === sec?.id);
      return store.taxLots.filter((l) => l.holdingId === holding?.id);
    };
    const btc = lotsOf('BTC');
    expect(btc.reduce((n, l) => n + Math.round(Number(l.quantity) * 1e8), 0)).toBe(5_000_000); // 0.05 BTC held
    expect(btc.every((l) => l.source === 'derived')).toBe(true);
    expect(btc[btc.length - 1]?.acquiredOn).toBe('2026-02-01');
    const eth = lotsOf('ETH');
    // 1.1958 received on 2026-02-20 at about 2449.45 plus the 0.0042 staking reward; together the 1.2 held.
    expect(eth.reduce((n, l) => n + Math.round(Number(l.quantity) * 1e8), 0)).toBe(120_000_000);
    expect(eth.map((l) => l.acquiredOn)).toEqual(['2026-02-20', '2026-03-01']);
    expect(eth.reduce((n, l) => n + l.costBasis, 0)).toBeGreaterThan(290_000);
  });

  it('asks for repair when the key is rejected', async () => {
    const s = S;
    await expectRepairOnExpiredToken(coinbaseAdapter, () =>
      makeCtx(
        s,
        fakeFetch({
          [`GET ${H}/user`]: { status: 401, json: fixture('coinbase', 'error_unauthorized.json') },
        }),
      ),
    );
  });
});
