import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_REGISTRY,
  LINK_ORDER,
  freeSlotsLeft,
  getConnector,
  withSlotUsage,
} from '../src/registry';
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
    ]) {
      expect(getConnector(id)?.availability, id).toBe('unavailable');
    }
  });
  it('counts free slots left with lifetime caps', () => {
    const live = withSlotUsage({ teller: 3, plaid: 10 });
    const teller = live.find((c) => c.id === 'teller');
    const plaid = live.find((c) => c.id === 'plaid');
    const sophtron = live.find((c) => c.id === 'sophtron');
    expect(teller && freeSlotsLeft(teller)).toBe(97);
    expect(plaid && freeSlotsLeft(plaid)).toBe(0);
    expect(sophtron && freeSlotsLeft(sophtron)).toBeNull();
  });
});
