import { describe, expect, it } from 'vitest';
import { ADAPTERS, MARKET_DATA_PROVIDERS } from '../src/adapters';
import {
  CONNECTOR_REGISTRY,
  LINK_ORDER,
  freeSlotsLeft,
  getConnector,
  withSlotUsage,
} from '../src/registry';
import { describeConnectors } from '../src/overview';
import { makeConnection, NOW } from './helpers/fakeFetch';

/** Connectors that have no adapter on purpose, with the reason. */
const NO_ADAPTER: Record<string, string> = {
  manual_vehicle: 'manual value',
  open_exchange_rates: 'fetched by the backend FX job',
  frankfurter: 'fetched by the backend FX job',
};

describe('connector registry', () => {
  it('has unique ids', () => {
    const ids = CONNECTOR_REGISTRY.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('lists every link-order entry', () => {
    for (const list of Object.values(LINK_ORDER)) {
      for (const id of list) expect(getConnector(id), id).toBeDefined();
    }
  });

  it('gives every unavailable or paid connector a reason', () => {
    for (const c of CONNECTOR_REGISTRY.filter((x) => x.availability !== 'available')) {
      expect(c.reason, c.id).toBeTruthy();
    }
  });

  it('marks business-only connectors unavailable', () => {
    for (const id of [
      'mercury',
      'brex',
      'mx',
      'finicity',
      'akoya',
      'apple_financekit',
      'zillow',
      'vinaudit',
      'capital_one_direct',
      'public_direct',
    ]) {
      expect(getConnector(id)?.availability, id).toBe('unavailable');
    }
  });

  it('counts free slots left with lifetime caps', () => {
    const live = withSlotUsage({ snaptrade: 3, plaid: 10 });
    const snaptrade = live.find((c) => c.id === 'snaptrade');
    const plaid = live.find((c) => c.id === 'plaid');
    const sophtron = live.find((c) => c.id === 'sophtron');
    expect(snaptrade && freeSlotsLeft(snaptrade)).toBe(17);
    expect(plaid && freeSlotsLeft(plaid)).toBe(0);
    expect(sophtron && freeSlotsLeft(sophtron)).toBeNull();
  });

  it("keeps the brief's free-slot facts", () => {
    expect(getConnector('teller')).toMatchObject({
      availability: 'unavailable',
      reason: 'Teller shut down its API in July 2026',
    });
    expect(getConnector('plaid')).toMatchObject({ freeSlotsTotal: 10, slotsAreLifetime: true });
    expect(getConnector('snaptrade')).toMatchObject({
      freeSlotsTotal: 20,
      slotsAreLifetime: false,
    });
    expect(getConnector('sophtron')).toMatchObject({ freeSlotsTotal: null });
  });
});

describe('registry and adapters agree', () => {
  it('every adapter has a registry entry, and its id matches', () => {
    for (const [id, adapter] of Object.entries(ADAPTERS)) {
      expect(adapter.id).toBe(id);
      expect(getConnector(id), `registry entry for ${id}`).toBeDefined();
    }
  });

  it('every available or paid connector has an adapter unless it is on the no-adapter list', () => {
    for (const c of CONNECTOR_REGISTRY.filter((x) => x.availability !== 'unavailable')) {
      if (NO_ADAPTER[c.id]) expect(ADAPTERS[c.id], c.id).toBeUndefined();
      else expect(ADAPTERS[c.id], `adapter for ${c.id}`).toBeDefined();
    }
  });

  it('unavailable connectors have no adapter', () => {
    for (const c of CONNECTOR_REGISTRY.filter((x) => x.availability === 'unavailable'))
      expect(ADAPTERS[c.id], c.id).toBeUndefined();
  });

  it('every adapter is built for a kind the registry names (market data provider order too)', () => {
    expect(MARKET_DATA_PROVIDERS.map((p) => getConnector(p.id)?.kinds[0])).toEqual([
      'market_data',
      'market_data',
      'market_data',
      'market_data',
    ]);
  });

  it('connectors that read holdings say whether lots come from the broker or are derived', () => {
    for (const id of ['plaid', 'ibkr_flex', 'indexa'])
      expect(getConnector(id)?.dataTypes, id).toContain('lots');
    for (const id of [
      'snaptrade',
      'trading212',
      'questrade',
      'coinbase',
      'kraken',
      'binance',
      'coinspot',
      'wazirx',
      'coinstats',
    ]) {
      expect(getConnector(id)?.dataTypes, id).toEqual(expect.arrayContaining(['holdings', 'lots']));
    }
  });
});

describe('connector overview for the Accounts screen', () => {
  it('lists usable connectors first, unavailable last with reasons, with slots and connection health', () => {
    const rows = describeConnectors(
      { plaid: 3 },
      [
        makeConnection('plaid', { status: 'needs_repair', lastError: 'Plaid: login expired.' }),
        makeConnection('sophtron'),
      ],
      NOW,
    );
    expect(rows[0]?.definition.availability).toBe('available');
    expect(rows[rows.length - 1]?.definition.availability).toBe('unavailable');
    const plaid = rows.find((r) => r.definition.id === 'plaid');
    expect(plaid?.slots).toMatchObject({ used: 3, left: 7 });
    expect(plaid?.definition.freeSlotsUsed).toBe(3);
    expect(plaid?.connections[0]?.health).toMatchObject({
      label: 'Repair needed',
      needsRepair: true,
    });
    expect(rows.find((r) => r.definition.id === 'mercury')?.definition.reason).toMatch(/business/i);
    const order = rows.map((r) => r.definition.availability);
    expect(order).toEqual(
      [...order].sort(
        (a, b) =>
          ({ available: 0, paid: 1, unavailable: 2 })[a] -
          { available: 0, paid: 1, unavailable: 2 }[b],
      ),
    );
  });
});
