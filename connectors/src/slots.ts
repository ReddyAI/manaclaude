import type { ConnectorDefinition, ConnectorKind } from '@manaclaude/shared';
import {
  CONNECTOR_REGISTRY,
  LINK_ORDER,
  freeSlotsLeft,
  getConnector,
  withSlotUsage,
} from './registry';

/**
 * Free-slot tracking. The ledger is FinanceDataset.connectorSlotsUsed:
 * connector id to the number of free connections used.
 *
 * - Lifetime caps (Teller 100 logins, Plaid Trial 10) count every login ever
 *   made. Deleting a connection does NOT give a slot back, which is why the app
 *   repairs a broken login instead of deleting and re-adding it.
 * - Other caps (SnapTrade's 20 connections) count live connections, so a delete
 *   frees a slot.
 */

export type SlotLedger = Readonly<Record<string, number>>;

export interface SlotStatus {
  connectorId: string;
  total: number | null;
  used: number;
  left: number | null;
  lifetime: boolean;
  exhausted: boolean;
  /** Three or fewer left on a capped connector. */
  low: boolean;
}

export function slotStatus(def: ConnectorDefinition, ledger: SlotLedger): SlotStatus {
  const live = withSlotUsage(ledger, [def])[0] as ConnectorDefinition;
  const left = freeSlotsLeft(live);
  return {
    connectorId: def.id,
    total: def.freeSlotsTotal,
    used: live.freeSlotsUsed,
    left,
    lifetime: def.slotsAreLifetime,
    exhausted: left !== null && left <= 0,
    low: left !== null && left > 0 && left <= 3,
  };
}

/** Can another free connection be added? Paid and unavailable connectors never take a free slot. */
export function canAddFreeConnection(def: ConnectorDefinition, ledger: SlotLedger): boolean {
  if (def.availability !== 'available') return false;
  return !slotStatus(def, ledger).exhausted;
}

/** New ledger after a connection is created. Always counts. */
export function recordConnectionCreated(
  ledger: SlotLedger,
  connectorId: string,
): Record<string, number> {
  return { ...ledger, [connectorId]: (ledger[connectorId] ?? 0) + 1 };
}

/**
 * New ledger after a connection is deleted. Lifetime caps keep the slot used;
 * other caps give it back. Unknown connectors are left alone.
 */
export function recordConnectionDeleted(
  ledger: SlotLedger,
  connectorId: string,
): Record<string, number> {
  const def = getConnector(connectorId);
  if (!def || def.slotsAreLifetime) return { ...ledger };
  return { ...ledger, [connectorId]: Math.max(0, (ledger[connectorId] ?? 0) - 1) };
}

/** What deleting a connection costs. The Accounts screen shows this before it confirms. */
export function deletionImpact(connectorId: string): { freesSlot: boolean; message: string } {
  const def = getConnector(connectorId);
  if (def?.slotsAreLifetime) {
    return {
      freesSlot: false,
      message: `${def.name} counts every login for life (${def.freeSlotsTotal} total). Deleting this one will not give the slot back. Repair it instead.`,
    };
  }
  return { freesSlot: true, message: 'Deleting frees the slot.' };
}

export interface ConnectorChoice {
  connectorId: string | null;
  /** Connectors passed over and why, in order. */
  skipped: { connectorId: string; reason: string }[];
}

/**
 * Pick the connector for a new login, in the brief's order: banks and cards
 * Teller, Sophtron, Plaid; brokerages SnapTrade, the broker's own API,
 * Sophtron, Plaid; paid fallbacks (SimpleFIN, Lunch Flow) only when allowed.
 * Plaid comes last on purpose: its 10 lifetime logins are kept for banks the
 * first two cannot reach, so pass those connectors in `exclude` once they fail.
 */
export function chooseConnector(
  kind: keyof typeof LINK_ORDER | ConnectorKind,
  ledger: SlotLedger,
  opts: { exclude?: ReadonlySet<string>; allowPaid?: boolean; region?: string } = {},
): ConnectorChoice {
  const order = kind in LINK_ORDER ? LINK_ORDER[kind as keyof typeof LINK_ORDER] : LINK_ORDER.bank;
  const list: readonly string[] =
    opts.allowPaid && kind !== 'paidFallback' ? [...order, ...LINK_ORDER.paidFallback] : order;
  const skipped: ConnectorChoice['skipped'] = [];
  for (const id of list) {
    const def = getConnector(id) ?? CONNECTOR_REGISTRY.find((c) => c.id === id);
    if (!def) continue;
    if (opts.exclude?.has(id)) {
      skipped.push({ connectorId: id, reason: 'excluded' });
      continue;
    }
    if (opts.region && !def.regions.includes(opts.region)) {
      skipped.push({ connectorId: id, reason: `not offered in ${opts.region}` });
      continue;
    }
    if (def.availability === 'paid' && !opts.allowPaid) {
      skipped.push({ connectorId: id, reason: 'paid' });
      continue;
    }
    if (def.availability === 'unavailable') {
      skipped.push({ connectorId: id, reason: def.reason ?? 'unavailable' });
      continue;
    }
    // Paid connectors have no free slots by definition; only free ones can run out.
    if (def.availability === 'available' && slotStatus(def, ledger).exhausted) {
      skipped.push({ connectorId: id, reason: 'no free slots left' });
      continue;
    }
    return { connectorId: id, skipped };
  }
  return { connectorId: null, skipped };
}
