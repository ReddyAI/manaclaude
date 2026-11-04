import type { ConnectorAdapter } from '@manaclaude/shared';

/**
 * Adapter lookup by connector id. Session D adds one file per adapter under
 * src/adapters/<id>/ and registers it here.
 */
export const ADAPTERS: Readonly<Record<string, ConnectorAdapter>> = {};

export function getAdapter(connectorId: string): ConnectorAdapter | undefined {
  return ADAPTERS[connectorId];
}
