import type { ConnectorAdapter } from '@manaclaude/shared';
import { akahuAdapter } from './akahu';
import { coinbaseAdapter } from './coinbase';
import { fioAdapter } from './fio';
import { lunchFlowAdapter } from './lunch_flow';
import { monobankAdapter } from './monobank';
import { plaidAdapter } from './plaid';
import { simplefinAdapter } from './simplefin';
import { snaptradeAdapter } from './snaptrade';
import { sophtronAdapter } from './sophtron';
import { tellerAdapter } from './teller';
import { upAdapter } from './up';
import { wazirxAdapter } from './wazirx';
import { zerodhaKiteAdapter } from './zerodha_kite';

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
  simplefinAdapter,
  lunchFlowAdapter,
  upAdapter,
  akahuAdapter,
  monobankAdapter,
  fioAdapter,
];

export const ADAPTERS: Readonly<Record<string, ConnectorAdapter>> = Object.fromEntries(
  list.map((a) => [a.id, a]),
);

export function getAdapter(connectorId: string): ConnectorAdapter | undefined {
  return ADAPTERS[connectorId];
}
