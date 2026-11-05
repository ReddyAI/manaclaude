import { describe, expect, it } from 'vitest';
import { realieAdapter } from '../src/adapters/realie';
import { rentcastAdapter, shouldRefreshValuation } from '../src/adapters/rentcast';
import { fakeFetch, fixture, makeConnection, makeCtx, NOW } from './helpers/fakeFetch';
import {
  expectRepairOnExpiredToken,
  expectRepeatSyncIsQuiet,
  expectSyncShape,
} from './helpers/contract';

const RC = {
  RENTCAST_API_KEY: 'rc-key',
  RENTCAST_ADDRESS: '5500 Demo Lake Dr, San Antonio, TX 78244',
};
const RL = {
  REALIE_API_KEY: 'realie-key',
  REALIE_ADDRESS: '5500 Demo Lake Dr',
  REALIE_STATE: 'tx',
  REALIE_CITY: 'San Antonio',
  REALIE_ZIP: '78244-1234',
};

describe('rentcast property value', () => {
  const ctx = (status = 200) =>
    makeCtx(
      RC,
      fakeFetch({
        'GET api.rentcast.io/v1/avm/value': { status, json: fixture('rentcast', 'avm.json') },
      }),
    );

  it('asks for the address with the API key and returns one USD property account', async () => {
    const fetch = fakeFetch({
      'GET api.rentcast.io/v1/avm/value': { json: fixture('rentcast', 'avm.json') },
    });
    const result = await rentcastAdapter.sync(makeCtx(RC, fetch), makeConnection('rentcast'));
    await expectSyncShape(result);
    expect(fetch.calls[0]?.headers['X-Api-Key']).toBe('rc-key');
    expect(fetch.calls[0]?.url.searchParams.get('address')).toBe(RC.RENTCAST_ADDRESS);
    expect(result.accounts).toEqual([
      expect.objectContaining({
        type: 'property',
        currency: 'USD',
        balance: 41_250_000,
        name: '5500 Demo Lake Dr, San Antonio, TX 78244',
      }),
    ]);
    expect(result.transactions).toEqual([]);
  });

  it('refreshes the same account on a repeat sync and spends calls monthly at most', async () => {
    await expectRepeatSyncIsQuiet(rentcastAdapter, () => ctx());
    expect(shouldRefreshValuation(null, NOW)).toBe(true);
    expect(shouldRefreshValuation('2026-10-20T00:00:00.000Z', NOW)).toBe(false);
    expect(shouldRefreshValuation('2026-10-01T00:00:00.000Z', NOW)).toBe(true);
  });

  it('asks for repair on 401 and treats a missing price as a data error', async () => {
    await expectRepairOnExpiredToken(rentcastAdapter, () => ctx(401));
    const none = makeCtx(RC, fakeFetch({ 'GET api.rentcast.io/v1/avm/value': { json: {} } }));
    await expect(rentcastAdapter.sync(none, makeConnection('rentcast'))).rejects.toThrow(
      /no valuation/,
    );
  });
});

describe('realie property value', () => {
  const ctx = (status = 200) =>
    makeCtx(
      RL,
      fakeFetch({
        'GET app.realie.ai/api/public/property/address/': {
          status,
          json: fixture('realie', 'property.json'),
        },
      }),
    );

  it('picks the record that matches the city and ZIP, and falls back to the assessor value', async () => {
    const fetch = fakeFetch({
      'GET app.realie.ai/api/public/property/address/': {
        json: fixture('realie', 'property.json'),
      },
    });
    const result = await realieAdapter.sync(makeCtx(RL, fetch), makeConnection('realie'));
    await expectSyncShape(result);
    expect(fetch.calls[0]?.headers.Authorization).toBe('realie-key');
    expect(fetch.calls[0]?.url.searchParams.get('state')).toBe('TX');
    expect(result.accounts[0]).toMatchObject({
      type: 'property',
      currency: 'USD',
      balance: 39_800_000,
      name: '5500 Demo Lake Dr, San Antonio, TX',
    });
  });

  it('is quiet on a repeat sync, rejects a location mismatch, and asks for repair on 401', async () => {
    await expectRepeatSyncIsQuiet(realieAdapter, () => ctx());
    const wrong = makeCtx(
      { ...RL, REALIE_CITY: 'Dallas' },
      fakeFetch({
        'GET app.realie.ai/api/public/property/address/': {
          json: fixture('realie', 'property.json'),
        },
      }),
    );
    await expect(realieAdapter.sync(wrong, makeConnection('realie'))).rejects.toThrow(
      /location mismatch/,
    );
    await expectRepairOnExpiredToken(realieAdapter, () => ctx(401));
  });
});
