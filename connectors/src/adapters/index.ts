import type { ConnectorAdapter } from '@manaclaude/shared';
import { tellerAdapter } from './teller';
import { sophtronAdapter } from './sophtron';
import { plaidAdapter } from './plaid';
import { snaptradeAdapter } from './snaptrade';
import { zerodhaKiteAdapter } from './zerodha_kite';
import { coinbaseAdapter } from './coinbase';
import { wazirxAdapter } from './wazirx';
import { simplefinAdapter } from './simplefin';
import { lunchFlowAdapter } from './lunch_flow';
import { upAdapter } from './up';
import { akahuAdapter } from './akahu';
import { monobankAdapter } from './monobank';
import { fioAdapter } from './fio';

/**
 * Adapter lookup by connector id. Session D adds one file per adapter under
 * src/adapters/<id>/ and registers it here.
 */
const list: ConnectorAdapter[] = [
  tellerAdapter,
  sophtronAdapter,
  plaidAdapter,
  snaptradeAdapter,
  zerodhaKiteAdapter,
  coinbaseAdapter,
  wazirxAdapter,
];

export const ADAPTERS: Readonly<Record<string, ConnectorAdapter>> = Object.fromEntries(
  list.map((a) => [a.id, a]),
);

export function getAdapter(connectorId: string): ConnectorAdapter | undefined {
  return ADAPTERS[connectorId];
}
