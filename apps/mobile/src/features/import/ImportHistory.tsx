import type { ImportRecord } from '@manaclaude/shared';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Button } from '../../design/components/Button';
import { Card } from '../../design/components/Card';
import { Badge, type BadgeTone } from '../../design/components/Controls';
import { Banner, EmptyState } from '../../design/components/Decor';
import { HStack, VStack } from '../../design/components/Layout';
import { Text } from '../../design/components/Text';
import { errorText } from '../../data/backend/client';
import { refreshDataset } from '../../data/backend/sync';
import { listImports, undoImport } from './importApi';
import { importStatusLabel } from './labels';

const TONE: Record<string, BadgeTone> = {
  committed: 'income',
  undone: 'neutral',
  failed: 'danger',
  committing: 'pending',
};
/** Previews that were never saved are not history. */
const LISTED = ['committed', 'undone', 'failed', 'committing'];

/**
 * Every file that was saved, undone or could not be read, newest first, with
 * what it added. A saved import can be undone here: its transactions are
 * removed, the original file stays in the vault.
 */
export function ImportHistory() {
  const [records, setRecords] = useState<ImportRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    () =>
      listImports().then(
        (list) => setRecords(list.filter((r) => LISTED.includes(r.status))),
        (e: unknown) => setError(errorText(e)),
      ),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const undo = async (record: ImportRecord) => {
    setBusy(record.id);
    setError(null);
    try {
      const removed = await undoImport(record.id);
      setNote(
        `Removed ${removed} ${removed === 1 ? 'transaction' : 'transactions'} from ${record.fileName}. Accounts and categories it made are still there.`,
      );
      setAsking(null);
      await Promise.all([load(), refreshDataset()]);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  /** The stored original of an import, on its own page. */
  const seeFile = (r: ImportRecord) => (
    <Button
      label="See the file"
      size="sm"
      variant="ghost"
      onPress={() => router.push({ pathname: '/vault/[id]', params: { id: r.id } })}
      testID={`import-file-${r.id}`}
    />
  );

  return (
    <VStack gap="md" testID="import-history">
      {error ? (
        <Banner tone="danger" icon="triangle-alert">
          <Text variant="caption">{error}</Text>
        </Banner>
      ) : null}
      {note ? (
        <Banner tone="accent" icon="info">
          <Text variant="caption" testID="import-history-note">
            {note}
          </Text>
        </Banner>
      ) : null}
      {records === null && !error ? (
        <Text variant="caption" tone="muted">
          Loading...
        </Text>
      ) : null}
      {records && records.length === 0 ? (
        <Card>
          <EmptyState
            icon="clock"
            title="No imports yet"
            message="Files you import are listed here, with a way to undo each one."
          />
        </Card>
      ) : null}
      {records && records.length > 0 ? (
        <Card padding="none">
          {records.map((r) => (
            <View key={r.id} style={styles.row} testID={`import-record-${r.id}`}>
              <HStack gap="sm" justify="space-between" align="center">
                <Text variant="bodyStrong" numberOfLines={1} style={styles.name}>
                  {r.fileName}
                </Text>
                <Badge label={importStatusLabel(r.status)} tone={TONE[r.status] ?? 'neutral'} />
              </HStack>
              <Text variant="caption" tone="muted">
                {[
                  (r.committedAt ?? r.createdAt).slice(0, 10),
                  r.status === 'committed'
                    ? `${r.rowsAdded} added, ${r.rowsMatched} already there, ${r.rowsSkipped} left out`
                    : r.status === 'undone'
                      ? `${r.rowsAdded} added, then removed by undo`
                      : null,
                  r.periodStart && r.periodEnd ? `${r.periodStart} to ${r.periodEnd}` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
              {r.error ? (
                <Text variant="caption" tone="pending">
                  {r.error}
                </Text>
              ) : null}
              {r.status === 'committed' ? (
                asking === r.id ? (
                  <VStack gap="xs">
                    <Text variant="caption">
                      {`Remove the ${r.rowsAdded} ${r.rowsAdded === 1 ? 'transaction' : 'transactions'} this import added? The file stays in the vault.`}
                    </Text>
                    <HStack gap="sm">
                      <Button
                        label="Yes, remove them"
                        size="sm"
                        variant="danger"
                        loading={busy === r.id}
                        onPress={() => void undo(r)}
                        testID={`import-undo-confirm-${r.id}`}
                      />
                      <Button
                        label="Keep"
                        size="sm"
                        variant="ghost"
                        onPress={() => setAsking(null)}
                      />
                    </HStack>
                  </VStack>
                ) : (
                  <HStack gap="sm">
                    <Button
                      label="Undo"
                      size="sm"
                      variant="secondary"
                      onPress={() => setAsking(r.id)}
                      testID={`import-undo-${r.id}`}
                    />
                    {seeFile(r)}
                  </HStack>
                )
              ) : (
                <HStack gap="sm">{seeFile(r)}</HStack>
              )}
            </View>
          ))}
        </Card>
      ) : null}
    </VStack>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    gap: theme.space.xs,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.md,
    borderBottomWidth: theme.size.hairline,
    borderColor: theme.colors.border,
  },
  name: { flex: 1 },
}));
