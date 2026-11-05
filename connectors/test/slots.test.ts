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
    expect(slotStatus(def('plaid'), { plaid: 3 })).toMatchObject({
      total: 10,
      used: 3,
      left: 7,
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
    const afterPlaid = recordConnectionCreated({}, 'plaid');
    expect(recordConnectionDeleted(afterPlaid, 'plaid')).toEqual({ plaid: 1 });
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
    expect(canAddFreeConnection(def('plaid'), {})).toBe(true);
    expect(canAddFreeConnection(def('plaid'), { plaid: 10 })).toBe(false);
    expect(canAddFreeConnection(def('teller'), {})).toBe(false);
    expect(canAddFreeConnection(def('simplefin'), {})).toBe(false);
    expect(canAddFreeConnection(def('mercury'), {})).toBe(false);
  });

  it('warns that deleting a lifetime login wastes the slot', () => {
    expect(deletionImpact('plaid')).toMatchObject({ freesSlot: false });
    expect(deletionImpact('plaid').message).toMatch(/Repair it instead/);
    expect(deletionImpact('snaptrade').freesSlot).toBe(true);
  });
});

describe('choosing a connector for a new login', () => {
  it('banks: Sophtron, then SimpleFIN, then Plaid (Teller shut down in July 2026)', () => {
    expect(chooseConnector('bank', {}).connectorId).toBe('sophtron');
    expect(chooseConnector('bank', {}, { exclude: new Set(['sophtron']) })).toMatchObject({
      connectorId: 'simplefin',
      skipped: [{ connectorId: 'sophtron', reason: 'excluded' }],
    });
    // SimpleFIN is paid but planned: it is not skipped as paid.
    expect(chooseConnector('bank', {}, { exclude: new Set(['sophtron']) }).connectorId).toBe(
      'simplefin',
    );
  });

  it('never offers Teller', () => {
    for (const kind of ['bank', 'brokerage', 'crypto', 'paidFallback'] as const) {
      const choice = chooseConnector(kind, {}, { allowPaid: true });
      expect(choice.connectorId).not.toBe('teller');
      expect(choice.skipped.map((s) => s.connectorId)).not.toContain('teller');
    }
  });

  it('keeps Plaid for banks the first two cannot reach', () => {
    expect(chooseConnector('bank', {}).connectorId).not.toBe('plaid');
    expect(
      chooseConnector('bank', {}, { exclude: new Set(['sophtron', 'simplefin']) }).connectorId,
    ).toBe('plaid');
    expect(
      chooseConnector('bank', { plaid: 10 }, { exclude: new Set(['sophtron', 'simplefin']) })
        .connectorId,
    ).toBeNull();
  });

  it('brokerages: SnapTrade, then Zerodha Kite, then Sophtron', () => {
    expect(chooseConnector('brokerage', {}).connectorId).toBe('snaptrade');
    expect(chooseConnector('brokerage', { snaptrade: 20 }).connectorId).toBe('zerodha_kite');
    expect(
      chooseConnector('brokerage', { snaptrade: 20 }, { exclude: new Set(['zerodha_kite']) })
        .connectorId,
    ).toBe('sophtron');
  });

  it("crypto: the exchange's own API, Coinbase then WazirX", () => {
    expect(chooseConnector('crypto', {}).connectorId).toBe('coinbase');
    expect(chooseConnector('crypto', {}, { exclude: new Set(['coinbase']) }).connectorId).toBe(
      'wazirx',
    );
  });

  it('other paid fallbacks only when allowed', () => {
    const none = new Set(['sophtron', 'simplefin', 'plaid']);
    expect(chooseConnector('bank', {}, { exclude: none }).connectorId).toBeNull();
    expect(chooseConnector('bank', {}, { exclude: none, allowPaid: true }).connectorId).toBe(
      'lunch_flow',
    );
    expect(chooseConnector('paidFallback', {}, { allowPaid: true }).connectorId).toBe('lunch_flow');
  });

  it('can limit by region', () => {
    expect(chooseConnector('brokerage', {}, { region: 'IN' }).connectorId).toBe('snaptrade');
    expect(chooseConnector('bank', {}, { region: 'NZ' }).connectorId).toBeNull();
  });
});
