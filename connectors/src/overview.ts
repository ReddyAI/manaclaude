import type { Connection, ConnectorDefinition } from '@manaclaude/shared';
import { CONNECTOR_REGISTRY } from './registry';
import { describeHealth, type HealthView } from './health';
import { slotStatus, type SlotLedger, type SlotStatus } from './slots';

/**
 * Everything the Accounts screen needs about connectors in one call: each
 * registry entry with its free slots and the connections made through it, with
 * their health. Unavailable connectors come last with their reason.
 */
export interface ConnectorRow {
  definition: ConnectorDefinition;
  slots: SlotStatus;
  connections: { connection: Connection; health: HealthView }[];
}

const ORDER = { available: 0, paid: 1, unavailable: 2 } as const;

export function describeConnectors(
  ledger: SlotLedger,
  connections: readonly Connection[],
  now: Date,
  registry: readonly ConnectorDefinition[] = CONNECTOR_REGISTRY,
): ConnectorRow[] {
  return registry
    .map((definition, index) => ({ definition, index }))
    .sort(
      (a, b) =>
        ORDER[a.definition.availability] - ORDER[b.definition.availability] || a.index - b.index,
    )
    .map(({ definition }) => ({
      definition: { ...definition, freeSlotsUsed: ledger[definition.id] ?? 0 },
      slots: slotStatus(definition, ledger),
      connections: connections
        .filter((c) => c.connectorId === definition.id)
        .map((connection) => ({ connection, health: describeHealth(connection, now) })),
    }));
}
