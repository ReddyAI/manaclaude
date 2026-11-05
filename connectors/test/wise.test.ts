import { describe, expect, it } from 'vitest';
import { wiseAdapter } from '../src/adapters/wise';
import { toBase64 } from '../src/util/crypto';
import { describeBankSuite } from './helpers/bankSuite';
import { fakeFetch, fixture, makeConnection, makeCtx } from './helpers/fakeFetch';

const SECRETS = { WISE_API_TOKEN: 'wise-demo-token' };
const H = 'api.wise.com';

const routes = (over: Record<string, unknown> = {}) => ({
  [`GET ${H}/v1/profiles`]: { json: fixture('wise', 'profiles.json') },
  [`GET ${H}/v4/profiles/1001/balances`]: { json: fixture('wise', 'balances.json') },
  [`GET ${H}/v1/profiles/1001/balance-statements/5001/statement.json`]: {
    json: fixture('wise', 'statement_5001.json'),
  },
  [`GET ${H}/v1/profiles/1001/balance-statements/5002/statement.json`]: {
    json: fixture('wise', 'statement_5002.json'),
  },
  ...over,
});
const ctx = () => makeCtx(SECRETS, fakeFetch(routes()));
const unauthorized = () =>
  makeCtx(
    SECRETS,
    fakeFetch({
      [`GET ${H}/v1/profiles`]: { status: 401, json: fixture('wise', 'error_unauthorized.json') },
    }),
  );

describeBankSuite({
  name: 'wise',
  adapter: wiseAdapter,
  ctx,
  accounts: {
    '1001_5001': { type: 'checking', currency: 'USD', balance: 125_075, institutionName: 'Wise' },
    '1001_5002': { currency: 'EUR', balance: 30_000, name: 'Euro jar' },
  },
  transactions: {
    'CARD-1': {
      amount: -4_210,
      originalAmount: -3_800,
      originalCurrency: 'EUR',
      merchantName: 'Bistro Lune',
    },
    'TRANSFER-9': {
      amount: 100_000,
      merchantName: 'Acme Inc',
      rawName: 'Received money from Acme Inc',
    },
    'CONVERSION-7': { amount: -20_000, kindHint: 'transfer' },
    'CONVERSION-8': { amount: 18_500, kindHint: 'transfer', currency: 'EUR' },
  },
  identical: { date: '2026-10-30', amount: -450 },
  repair: [unauthorized],
  health: { ok: ctx, expired: unauthorized },
});

describe('wise specifics', () => {
  it('uses the personal profile and asks for a year at most', async () => {
    const fetch = fakeFetch(routes());
    await wiseAdapter.sync(makeCtx(SECRETS, fetch), makeConnection('wise'));
    expect(fetch.calls[0]?.headers.Authorization).toBe('Bearer wise-demo-token');
    const stmt = fetch.calls.find((c) => c.url.pathname.endsWith('/5001/statement.json'));
    expect(stmt?.url.searchParams.get('currency')).toBe('USD');
    expect(stmt?.url.searchParams.get('intervalStart')).toBe('2025-11-05T00:00:00.000Z');
    expect(stmt?.url.searchParams.get('type')).toBe('COMPACT');
  });

  it('answers a strong customer authentication challenge with an RSA signature and retries once', async () => {
    const pair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    );
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
    const pem = (label: string, der: Uint8Array) =>
      `-----BEGIN ${label}-----\n${toBase64(der)}\n-----END ${label}-----`;
    // The same key in the older PKCS1 form must work too.
    for (const key of [pem('PRIVATE KEY', pkcs8), pem('RSA PRIVATE KEY', pkcs8.slice(26))]) {
      let n = 0;
      const fetch = fakeFetch(
        routes({
          [`GET ${H}/v1/profiles/1001/balance-statements/5001/statement.json`]: (call: {
            headers: Record<string, string>;
          }) => {
            n++;
            return call.headers['x-2fa-approval']
              ? { json: fixture('wise', 'statement_5001.json') }
              : { status: 403, json: {}, headers: { 'x-2fa-approval': 'challenge-token-1' } };
          },
        }),
      );
      const result = await wiseAdapter.sync(
        makeCtx({ ...SECRETS, WISE_SCA_PRIVATE_KEY: key }, fetch),
        makeConnection('wise'),
      );
      expect(result.transactions.length).toBeGreaterThan(0);
      expect(n).toBe(2);
      const retried = fetch.calls.filter((c) => c.url.pathname.endsWith('/5001/statement.json'))[1];
      const sig = retried?.headers['X-Signature'] ?? '';
      const raw = Uint8Array.from(atob(sig), (c) => c.charCodeAt(0));
      expect(
        await crypto.subtle.verify(
          'RSASSA-PKCS1-v1_5',
          pair.publicKey,
          raw,
          new TextEncoder().encode('challenge-token-1'),
        ),
      ).toBe(true);
    }
  });

  it('asks for repair on a 403 when there is no SCA key', async () => {
    const forbidden = makeCtx(
      SECRETS,
      fakeFetch(
        routes({
          [`GET ${H}/v1/profiles/1001/balance-statements/5001/statement.json`]: {
            status: 403,
            json: {},
            headers: { 'x-2fa-approval': 'c' },
          },
        }),
      ),
    );
    await expect(wiseAdapter.sync(forbidden, makeConnection('wise'))).rejects.toThrow(
      /Repair the connection/,
    );
  });
});
