import { CONNECTOR_REGISTRY, withSlotUsage } from '@manaclaude/connectors/registry';
import { useMemo } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Card } from '../../design/components/Card';
import { Badge } from '../../design/components/Controls';
import { IconBadge, SectionHeader } from '../../design/components/Decor';
import { ListRow } from '../../design/components/ListRow';
import { Text } from '../../design/components/Text';
import { useFinance } from '../../data/store';
import { groupConnectors, KIND_LABEL, lastSyncText, type ConnectorSummary } from './health';

function connectorIcon(s: ConnectorSummary) {
  if (s.unavailableReason) return 'lock';
  const kinds = s.connector.kinds;
  if (kinds.includes('crypto')) return 'coins';
  if (kinds.includes('brokerage')) return 'trending-up';
  if (kinds.includes('property') || kinds.includes('vehicle')) return 'home';
  return 'building';
}

/**
 * Every connector from the registry (session D keeps it current) with its
 * status, free slots left and last sync. Unavailable ones are greyed out and
 * say why.
 */
export function ConnectorsList() {
  const data = useFinance();
  const registry = useMemo(
    () => withSlotUsage(data.connectorSlotsUsed, CONNECTOR_REGISTRY),
    [data.connectorSlotsUsed],
  );
  const groups = useMemo(
    () => groupConnectors(registry, data.connections),
    [registry, data.connections],
  );

  return (
    <>
      <Text variant="caption" tone="muted">
        Personal access only. Free connectors come first; lifetime logins never come back, so repair
        a broken connection instead of removing it.
      </Text>
      {groups.map(([kind, list]) => (
        <View key={kind}>
          <SectionHeader title={KIND_LABEL[kind] ?? kind} />
          <Card padding="none">
            {list.map((s) => (
              <View key={s.connector.id} testID={`connector-${s.connector.id}`}>
                <ListRow
                  title={s.connector.name}
                  subtitle={s.unavailableReason ? 'Not available for personal use' : s.slots}
                  trailingCaption={
                    s.unavailableReason || s.connections.length === 0
                      ? undefined
                      : lastSyncText(s.lastSyncAt)
                  }
                  leading={
                    <IconBadge icon={connectorIcon(s)} color={s.unavailableReason ? 'c12' : 'c1'} />
                  }
                  trailing={<Badge label={s.badge.label} tone={s.badge.tone} />}
                  dimmed={s.unavailableReason !== null}
                />
                {s.unavailableReason ? (
                  <Text variant="caption" tone="faint" style={styles.reason}>
                    {s.unavailableReason}
                  </Text>
                ) : null}
              </View>
            ))}
          </Card>
        </View>
      ))}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Lines up under the connector name: row padding + icon + gap.
  reason: {
    paddingLeft: theme.space.lg + theme.size.avatarMd + theme.space.md,
    paddingRight: theme.space.lg,
    paddingBottom: theme.space.md,
  },
}));
