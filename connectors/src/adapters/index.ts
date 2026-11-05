import type { ConnectorAdapter } from '@manaclaude/shared';
import { tellerAdapter } from './teller';
import { sophtronAdapter } from './sophtron';
import { plaidAdapter } from './plaid';

/**
 * Adapter lookup by connector id. Session D adds one file per adapter under
 * src/adapters/<id>/ and registers it here.
 */
const list: ConnectorAdapter[] = [tellerAdapter, sophtronAdapter, plaidAdapter];

export const ADAPTERS: Readonly<Record<string, ConnectorAdapter>> = Object.fromEntries(
  list.map((a) => [a.id, a]),
);

export function getAdapter(connectorId: string): ConnectorAdapter | undefined {
  return ADAPTERS[connectorId];
}
