import { planRepair } from '@manaclaude/connectors/health';
import { getConnector } from '@manaclaude/connectors/registry';
import { useLocalSearchParams } from 'expo-router';
import { useState, type ComponentType } from 'react';
import { Card } from '../../design/components/Card';
import { EmptyState } from '../../design/components/Decor';
import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import { isBackendReady, useBackendConfig } from '../../data/backend/config';
import { useFinance } from '../../data/store';
import { BackAction } from '../planning/BackAction';
import { BrowserFlow } from './BrowserFlow';
import { KeysFlow } from './KeysFlow';
import { PlaidFlow } from './PlaidFlow';
import { SimplefinFlow } from './SimplefinFlow';
import { SophtronFlow } from './SophtronFlow';
import { SyncStep } from './SyncStep';
import type { FlowProps } from './types';

const FLOWS: Record<string, ComponentType<FlowProps>> = {
  sophtron: SophtronFlow,
  simplefin: SimplefinFlow,
  plaid: PlaidFlow,
  snaptrade: BrowserFlow,
  zerodha_kite: BrowserFlow,
  coinbase: KeysFlow,
  wazirx: KeysFlow,
};

/** Link one connector, or repair one connection (?connectionId=...), then fetch its data. */
export function ConnectorLinkScreen({
  connector: connectorProp,
  connectionId: connectionProp,
}: { connector?: string; connectionId?: string } = {}) {
  const params = useLocalSearchParams<{ connector?: string; connectionId?: string }>();
  const connector = connectorProp ?? params.connector ?? '';
  const connectionId = connectionProp ?? params.connectionId ?? undefined;
  const def = getConnector(connector);
  const data = useFinance();
  const config = useBackendConfig();
  const [linked, setLinked] = useState<{ ids: string[]; repaired: boolean } | null>(null);
  const connection = connectionId ? data.connections.find((c) => c.id === connectionId) : undefined;
  const plan = connection && def ? planRepair(connection, def) : null;
  const Flow = FLOWS[connector];
  const title = def ? `${connectionId ? 'Repair' : 'Link'} ${def.name}` : 'Link';

  return (
    <Screen
      title={title}
      actions={<BackAction fallback="/link" />}
      testID={`screen-link-${connector}`}
    >
      {!Flow || !def || def.availability === 'unavailable' ? (
        <Card>
          <EmptyState
            icon="lock"
            title="Not available"
            message={def?.reason ?? 'This connector cannot be linked from the app.'}
          />
        </Card>
      ) : !isBackendReady(config) ? (
        <Card>
          <EmptyState
            icon="cloud-off"
            title="Set up the backend first"
            message="Enter the Worker address and API token in Settings, Backend."
          />
        </Card>
      ) : linked ? (
        <SyncStep connectionIds={linked.ids} repaired={linked.repaired} />
      ) : (
        <>
          {plan ? (
            <Card tone="sunken">
              <Text variant="body">{`${connection?.institutionName}: ${plan.instructions}`}</Text>
            </Card>
          ) : null}
          <Flow
            connector={connector}
            connectionId={connectionId}
            onLinked={(ids, repaired) => setLinked({ ids, repaired })}
          />
        </>
      )}
    </Screen>
  );
}
