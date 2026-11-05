import { getConnector } from '@manaclaude/connectors/registry';
import type { LinkConnectorOption, LinkKind, LinkOptionsResponse } from '@manaclaude/shared';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Card } from '../../design/components/Card';
import { Badge } from '../../design/components/Controls';
import { Banner, EmptyState, IconBadge, SectionHeader } from '../../design/components/Decor';
import { ListRow } from '../../design/components/ListRow';
import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import { errorText } from '../../data/backend/client';
import { isBackendReady, useBackendConfig } from '../../data/backend/config';
import { BackAction } from '../planning/BackAction';
import { linkApi } from './linkApi';

const SECTIONS: { kind: LinkKind; title: string; icon: 'landmark' | 'trending-up' | 'coins' }[] = [
  { kind: 'bank', title: 'US banks and cards', icon: 'landmark' },
  { kind: 'brokerage', title: 'Brokerages', icon: 'trending-up' },
  { kind: 'crypto', title: 'Crypto exchanges', icon: 'coins' },
];

const NOTES: Record<string, string> = {
  sophtron: 'Free, 10,000 requests a month',
  simplefin: '$15 a year, 25 banks, one refresh a day',
  plaid: 'Only for a bank the other two cannot reach',
  snaptrade: 'Robinhood, E*TRADE, Zerodha and more',
  zerodha_kite: 'Zerodha direct; log in once a day',
  coinbase: 'A read-only API key',
  wazirx: 'A read-only API key',
};

export function slotText(o: LinkConnectorOption): string | null {
  if (o.slots.total === null || o.slots.total === 0) return null;
  return `${o.slots.left} of ${o.slots.total} ${o.slots.lifetime ? 'lifetime logins' : 'connections'} left`;
}

/**
 * Add account (session E2): every way to link, in the order to try them.
 * US banks and cards: Sophtron, SimpleFIN, then Plaid. Brokerages: SnapTrade,
 * Zerodha Kite, Sophtron. Crypto: the exchange's own API. India NRE and NRO:
 * statement import.
 */
export function LinkHomeScreen() {
  const config = useBackendConfig();
  const ready = isBackendReady(config);
  const [options, setOptions] = useState<LinkOptionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    let live = true;
    linkApi.options().then(
      (o) => live && setOptions(o),
      (e: unknown) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [ready]);

  const row = (o: LinkConnectorOption, first: boolean, icon: string, kind: LinkKind) => {
    // Plaid stays tappable while it is switched off, so its confirmation can be seen; the backend refuses the call.
    const blocked = o.blockedReason !== null && !(o.id === 'plaid' && o.slots.left !== 0);
    return (
      <ListRow
        key={o.id}
        title={o.name}
        subtitle={o.blockedReason ?? [NOTES[o.id], slotText(o)].filter(Boolean).join(' · ')}
        leading={<IconBadge icon={icon as 'landmark'} color={blocked ? 'c12' : 'c1'} />}
        trailing={first && !blocked ? <Badge label="Try first" tone="accent" /> : undefined}
        dimmed={blocked}
        showChevron={!blocked}
        onPress={
          blocked
            ? undefined
            : () => router.push({ pathname: '/link/[connector]', params: { connector: o.id } })
        }
        testID={`link-${kind}-${o.id}`}
      />
    );
  };

  return (
    <Screen title="Add account" actions={<BackAction fallback="/accounts" />} testID="screen-link">
      {!ready ? (
        <Card>
          <EmptyState
            icon="cloud-off"
            title="Set up the backend first"
            message="Enter the Worker address and your API token in Settings, Backend. Then come back here."
            actionLabel="Open Settings"
            onAction={() => router.push('/settings')}
          />
        </Card>
      ) : null}
      {error ? (
        <Banner tone="danger" icon="triangle-alert">
          <Text variant="caption">{error}</Text>
        </Banner>
      ) : null}
      {ready && !options && !error ? <ActivityIndicator accessibilityLabel="Loading" /> : null}
      {options && !options.credentialsReady ? (
        <Banner tone="pending" icon="lock">
          <Text variant="caption">
            {
              "CREDENTIALS_SECRET is not set on the backend, so logins can't be saved yet. Add it as a GitHub secret and run the deploy again."
            }
          </Text>
        </Banner>
      ) : null}
      {options
        ? SECTIONS.map((s) => {
            const list = options.order[s.kind]
              .map((id) => options.connectors.find((c) => c.id === id))
              .filter((c): c is LinkConnectorOption => !!c);
            const firstUsable = list.find((c) => c.blockedReason === null)?.id;
            return (
              <View key={s.kind}>
                <SectionHeader title={s.title} />
                <Card padding="none">
                  {list.map((c) => row(c, c.id === firstUsable, s.icon, s.kind))}
                </Card>
              </View>
            );
          })
        : null}
      {ready ? (
        <View>
          <SectionHeader title="India NRE and NRO" />
          <Card padding="none">
            <ListRow
              title="Import a statement"
              subtitle="PDF or CSV from your bank, also OFX and QIF"
              leading={<IconBadge icon="file-up" color="c5" />}
              showChevron
              onPress={() => router.push('/import')}
              testID="link-import"
            />
          </Card>
        </View>
      ) : null}
      <Text variant="caption" tone="faint">
        {`Teller is not offered: ${getConnector('teller')?.reason ?? 'it shut down its API'}.`}
      </Text>
    </Screen>
  );
}
