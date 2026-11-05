import { getConnector } from '@manaclaude/connectors/registry';
import type { Connection } from '@manaclaude/shared';
import { useState } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Button } from '../../design/components/Button';
import { Card } from '../../design/components/Card';
import { Badge } from '../../design/components/Controls';
import { SectionHeader } from '../../design/components/Decor';
import { HStack, VStack } from '../../design/components/Layout';
import { Text } from '../../design/components/Text';
import { haptic } from '../../design/haptics';
import { errorText } from '../../data/backend/client';
import { isBackendReady, useBackendConfig } from '../../data/backend/config';
import { refreshDataset } from '../../data/backend/sync';
import { useFinance } from '../../data/store';
import { connectionHealth, lastSyncText } from '../accounts/health';
import { syncUntilDone } from './linkApi';
import { startRepair } from './repair';

/** Your logins, each with Sync now (and Repair when it needs one). Shown on the Connectors tab. */
export function ConnectionsCard() {
  const data = useFinance();
  const config = useBackendConfig();
  const ready = isBackendReady(config);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  if (data.connections.length === 0) return null;

  const syncNow = async (c: Connection) => {
    setBusy((b) => ({ ...b, [c.id]: 'Syncing...' }));
    setNotes((n) => ({ ...n, [c.id]: '' }));
    try {
      const report = await syncUntilDone(c.id, (p) =>
        setBusy((b) => ({
          ...b,
          [c.id]: p.inserted > 0 ? `${p.inserted.toLocaleString()} new...` : 'Syncing...',
        })),
      );
      await refreshDataset();
      const text =
        report.outcome === 'ok'
          ? `Synced. ${report.summary?.inserted ?? 0} new.`
          : report.outcome === 'skipped'
            ? (report.error ?? 'Skipped: repair the login first.')
            : (report.error ?? 'The sync failed.');
      setNotes((n) => ({ ...n, [c.id]: text }));
      haptic(report.outcome === 'ok' ? 'confirm' : 'reject');
    } catch (e) {
      setNotes((n) => ({ ...n, [c.id]: errorText(e) }));
    } finally {
      setBusy(({ [c.id]: _done, ...rest }) => rest);
    }
  };

  return (
    <View>
      <SectionHeader title="Your connections" />
      <Card padding="none">
        {data.connections.map((c) => {
          const health = connectionHealth(c);
          const needsRepair = c.status === 'needs_repair';
          return (
            <View key={c.id} style={styles.row} testID={`connection-${c.id}`}>
              <VStack gap="xxs" flex={1}>
                <Text variant="bodyStrong" numberOfLines={1}>
                  {c.institutionName}
                </Text>
                <Text variant="caption" tone="muted" numberOfLines={2}>
                  {notes[c.id] ||
                    `${getConnector(c.connectorId)?.name ?? c.connectorId} · ${lastSyncText(c.lastSuccessfulSyncAt)}`}
                </Text>
              </VStack>
              <HStack gap="xs">
                <Badge label={health.label} tone={health.tone} />
                {ready ? (
                  needsRepair ? (
                    <Button
                      label="Repair"
                      size="sm"
                      variant="secondary"
                      onPress={() =>
                        void startRepair(c).then((m) => m && setNotes((n) => ({ ...n, [c.id]: m })))
                      }
                      testID={`repair-${c.id}`}
                    />
                  ) : (
                    <Button
                      label={busy[c.id] ?? 'Sync now'}
                      size="sm"
                      variant="secondary"
                      loading={Boolean(busy[c.id])}
                      onPress={() => void syncNow(c)}
                      testID={`sync-${c.id}`}
                    />
                  )
                ) : null}
              </HStack>
            </View>
          );
        })}
      </Card>
      {!ready ? (
        <Text variant="caption" tone="faint" style={styles.note}>
          Sample connections. Set up the backend in Settings to link and sync your own.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.md,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.md,
    borderBottomWidth: theme.size.hairline,
    borderColor: theme.colors.border,
  },
  note: { paddingHorizontal: theme.space.lg, paddingTop: theme.space.sm },
}));
