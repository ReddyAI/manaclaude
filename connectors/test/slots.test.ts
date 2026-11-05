import { describe, expect, it } from 'vitest';
import {
  chooseConnector,
  canAddFreeConnection,
  deletionImpact,
  recordConnectionCreated,
  recordConnectionDeleted,
  slotStatus,
} from '../src/slots';
import { getConnector } from '../src/registry';

const def = (id: string) => getConnector(id)!;

describe('slot tracking', () => {
  it('counts free slots left, flags low and exhausted', () => {
    expect(slotStatus(def('teller'), { teller: 3 })).toMatchObject({
      total: 100,
      used: 3,
      left: 97,
      lifetime: true,
      exhausted: false,
      low: false,
    });
    expect(slotStatus(def('plaid'), { plaid: 8 })).toMatchObject({ left: 2, low: true });
    expect(slotStatus(def('plaid'), { plaid: 10 })).toMatchObject({ left: 0, exhausted: true });
    expect(slotStatus(def('sophtron'), {})).toMatchObject({
      total: null,
      left: null,
      exhausted: false,
    });
  });

  it('lifetime caps never give a slot back; other caps do', () => {
    const afterTeller = recordConnectionCreated({}, 'teller');
    expect(recordConnectionDeleted(afterTeller, 'teller')).toEqual({ teller: 1 });
    const afterSnap = recordConnectionCreated({ snaptrade: 4 }, 'snaptrade');
    expect(afterSnap).toEqual({ snaptrade: 5 });
    expect(recordConnectionDeleted(afterSnap, 'snaptrade')).toEqual({ snaptrade: 4 });
    expect(recordConnectionDeleted({}, 'snaptrade')).toEqual({ snaptrade: 0 });
  });

  it('does not change the ledger it was given', () => {
    const ledger = Object.freeze({ plaid: 1 });
    expect(recordConnectionCreated(ledger, 'plaid')).toEqual({ plaid: 2 });
    expect(ledger).toEqual({ plaid: 1 });
  });

  it('only free connectors with slots can be added; paid and unavailable never', () => {
    expect(canAddFreeConnection(def('teller'), {})).toBe(true);
    expect(canAddFreeConnection(def('teller'), { teller: 100 })).toBe(false);
    expect(canAddFreeConnection(def('simplefin'), {})).toBe(false);
    expect(canAddFreeConnection(def('mercury'), {})).toBe(false);
  });

  it('warns that deleting a lifetime login wastes the slot', () => {
    expect(deletionImpact('teller')).toMatchObject({ freesSlot: false });
    expect(deletionImpact('teller').message).toMatch(/Repair it instead/);
    expect(deletionImpact('snaptrade').freesSlot).toBe(true);
  });
});

describe('choosing a connector for a new login', () => {
  it('banks: Teller, then Sophtron, then Plaid', () => {
    expect(chooseConnector('bank', {}).connectorId).toBe('teller');
    expect(chooseConnector('bank', { teller: 100 })).toMatchObject({
      connectorId: 'sophtron',
      skipped: [{ connectorId: 'teller', reason: 'no free slots left' }],
    });
    expect(chooseConnector('bank', {}, { exclude: new Set(['teller']) }).connectorId).toBe(
      'sophtron',
    );
  });

  it('keeps Plaid for banks the first two cannot reach', () => {
    expect(chooseConnector('bank', {}).connectorId).not.toBe('plaid');
    expect(
      chooseConnector('bank', {}, { exclude: new Set(['teller', 'sophtron']) }).connectorId,
    ).toBe('plaid');
    expect(
      chooseConnector('bank', { plaid: 10 }, { exclude: new Set(['teller', 'sophtron']) })
        .connectorId,
    ).toBeNull();
  });

  it('brokerages: SnapTrade first, then the broker API, Sophtron, Plaid', () => {
    expect(chooseConnector('brokerage', {}).connectorId).toBe('snaptrade');
    expect(chooseConnector('brokerage', { snaptrade: 20 }).connectorId).toBe('ibkr_flex');
  });

  it('paid fallbacks only when allowed, SimpleFIN before Lunch Flow', () => {
    const none = new Set(['teller', 'sophtron', 'plaid']);
    expect(chooseConnector('bank', {}, { exclude: none }).connectorId).toBeNull();
    expect(chooseConnector('bank', {}, { exclude: none, allowPaid: true }).connectorId).toBe(
      'simplefin',
    );
    expect(chooseConnector('paidFallback', {}, { allowPaid: true }).connectorId).toBe('simplefin');
  });

  it('can limit by region', () => {
    expect(chooseConnector('brokerage', {}, { region: 'IN' }).connectorId).toBe('snaptrade');
    expect(chooseConnector('bank', {}, { region: 'NZ' }).connectorId).toBeNull();
  });
});
