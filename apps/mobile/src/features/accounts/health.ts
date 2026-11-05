import { freeSlotsLeft } from '@manaclaude/connectors/registry';
import type {
  Connection,
  ConnectionStatus,
  ConnectorDefinition,
  ConnectorKind,
} from '@manaclaude/shared';
import type { BadgeTone } from '../../design/components/Controls';

/** Connector status, free slots and sync health for the Accounts screen (session A). */

export interface StatusBadge {
  label: string;
  tone: BadgeTone;
}

const CONNECTION_STATUS: Record<ConnectionStatus, StatusBadge> = {
  healthy: { label: 'Synced', tone: 'income' },
  syncing: { label: 'Syncing', tone: 'accent' },
  needs_repair: { label: 'Repair', tone: 'pending' },
  error: { label: 'Error', tone: 'danger' },
  disconnected: { label: 'Off', tone: 'neutral' },
};

/** Worst first: what the connector row shows when it has several logins. */
const SEVERITY: ConnectionStatus[] = [
  'error',
  'needs_repair',
  'disconnected',
  'syncing',
  'healthy',
];

export function timeAgo(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'never';
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export function lastSyncText(iso: string | null, now?: number): string {
  return iso ? `Synced ${timeAgo(iso, now)}` : 'Never synced';
}

export function connectionHealth(connection: Pick<Connection, 'status'>): StatusBadge {
  return CONNECTION_STATUS[connection.status];
}

/** "97 of 100 logins left" (lifetime caps never come back), "No slot limit", or the price for paid ones. */
export function slotsText(c: ConnectorDefinition): string {
  if (c.freeSlotsTotal === null) return 'No slot limit';
  if (c.freeSlotsTotal === 0) return c.cost;
  const left = freeSlotsLeft(c) ?? 0;
  return `${left} of ${c.freeSlotsTotal} ${c.slotsAreLifetime ? 'logins' : 'connections'} left`;
}

export interface ConnectorSummary {
  connector: ConnectorDefinition;
  connections: Connection[];
  /** Why it is greyed out; null when usable. */
  unavailableReason: string | null;
  badge: StatusBadge;
  slots: string;
  lastSyncAt: string | null;
}

export function summarizeConnector(
  connector: ConnectorDefinition,
  allConnections: readonly Connection[],
): ConnectorSummary {
  const connections = allConnections.filter((c) => c.connectorId === connector.id);
  const unavailable = connector.availability === 'unavailable';
  const worst = SEVERITY.find((s) => connections.some((c) => c.status === s));
  const lastSyncAt =
    connections
      .map((c) => c.lastSyncAt)
      .filter((t): t is string => !!t)
      .sort()
      .at(-1) ?? null;
  const badge: StatusBadge = unavailable
    ? { label: 'Unavailable', tone: 'neutral' }
    : worst
      ? CONNECTION_STATUS[worst]
      : connector.availability === 'paid'
        ? { label: 'Paid', tone: 'pending' }
        : { label: 'Available', tone: 'accent' };
  return {
    connector,
    connections,
    unavailableReason: unavailable ? (connector.reason ?? 'Not available for personal use') : null,
    badge,
    slots: slotsText(connector),
    lastSyncAt,
  };
}

export const KIND_LABEL: Partial<Record<ConnectorKind, string>> = {
  bank: 'Banks and cards',
  brokerage: 'Brokerages',
  crypto: 'Crypto',
  property: 'Property and vehicles',
  market_data: 'Market data and FX',
};

export function connectorGroupKind(c: ConnectorDefinition): ConnectorKind {
  if (c.kinds.includes('fx') || c.kinds.includes('market_data')) return 'market_data';
  if (c.kinds.includes('vehicle') || c.kinds.includes('property')) return 'property';
  if (c.kinds.includes('crypto') && c.kinds.length === 1) return 'crypto';
  if (c.kinds.includes('brokerage') && !c.kinds.includes('bank')) return 'brokerage';
  return 'bank';
}

const AVAILABILITY_ORDER: Record<ConnectorDefinition['availability'], number> = {
  available: 0,
  paid: 1,
  unavailable: 2,
};

/**
 * Every connector in the registry, grouped by what it connects. Usable ones
 * first, then paid, then unavailable (greyed out with their reason).
 */
export function groupConnectors(
  registry: readonly ConnectorDefinition[],
  connections: readonly Connection[],
): [ConnectorKind, ConnectorSummary[]][] {
  const groups = new Map<ConnectorKind, ConnectorSummary[]>();
  for (const c of registry) {
    const kind = connectorGroupKind(c);
    groups.set(kind, [...(groups.get(kind) ?? []), summarizeConnector(c, connections)]);
  }
  for (const list of groups.values()) {
    list.sort(
      (a, b) =>
        AVAILABILITY_ORDER[a.connector.availability] - AVAILABILITY_ORDER[b.connector.availability],
    );
  }
  return [...groups.entries()];
}
