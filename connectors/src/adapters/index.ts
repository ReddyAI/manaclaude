import type { ConnectorAdapter } from '@manaclaude/shared';
import { tellerAdapter } from './teller';

/**
 * Adapter lookup by connector id. Session D adds one file per adapter under
 * src/adapters/<id>/ and registers it here.
 */
const list: ConnectorAdapter[] = [tellerAdapter];

export const ADAPTERS: Readonly<Record<string, ConnectorAdapter>> = Object.fromEntries(
  list.map((a) => [a.id, a]),
);

export function getAdapter(connectorId: string): ConnectorAdapter | undefined {
  return ADAPTERS[connectorId];
}
