import { formatShortDate, todayLocal, type Account, type ImportMapping } from '@manaclaude/shared';
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Button } from '../../design/components/Button';
import { Card } from '../../design/components/Card';
import { Banner, EmptyState } from '../../design/components/Decor';
import { VStack } from '../../design/components/Layout';
import { Text } from '../../design/components/Text';
import { errorText } from '../../data/backend/client';
import { useBackendConfig } from '../../data/backend/config';
import { useToday } from '../../data/selectors';
import { useFinance } from '../../data/store';
import { listImportMappings } from './importApi';
import { dateFormatLabel } from './labels';

/** Where a layout's rows went last time, in words. */
export function layoutAccountText(
  accountId: string | null,
  accounts: readonly Pick<Account, 'id' | 'name'>[],
): string {
  if (accountId === null) return 'No account saved with it';
  const account = accounts.find((a) => a.id === accountId);
  return account ? `Into "${account.name}"` : 'Into an account not on this device';
}

/** The columns a layout reads, in one line. */
export function layoutColumnsText(layout: ImportMapping): string {
  const m = layout.mapping;
  return [
    `Dates ${dateFormatLabel(m.dateFormat).toLowerCase()}`,
    m.amountMode === 'debit_credit' ? 'money out and in in two columns' : 'one amount column',
    m.skipRows > 0 ? `skips ${m.skipRows} ${m.skipRows === 1 ? 'line' : 'lines'} first` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * The CSV layouts the Worker saved (GET /v1/import-mappings), most recently
 * used first. Read-only: the next file with the same columns imports with its
 * layout. The Worker has no way to remove one yet.
 */
export function SavedLayouts() {
  const data = useFinance();
  const today = useToday();
  const { scope } = useBackendConfig();
  const [round, setRound] = useState(0);
  // A changed backend (scope) or Try again (round) makes a new request. Until
  // it answers, the list shows Loading; an older request's late answer, or
  // its error, is dropped.
  const request = `${scope}:${round}`;
  const [result, setResult] = useState<{
    request: string;
    layouts?: ImportMapping[];
    error?: string;
  } | null>(null);

  useEffect(() => {
    let live = true;
    // A list from an older backend never arrives: api() drops it as superseded.
    listImportMappings().then(
      (list) => setResult({ request, layouts: list }),
      (e: unknown) => {
        if (live) setResult({ request, error: errorText(e) });
      },
    );
    return () => {
      live = false;
    };
  }, [request]);

  const current = result?.request === request ? result : null;
  const layouts = current?.layouts ?? null;
  const error = current?.error ?? null;

  const retry = useCallback(() => setRound((r) => r + 1), []);

  return (
    <VStack gap="md" testID="saved-layouts">
      <Text variant="caption" tone="muted">
        When an import of a bank CSV is saved, your Worker keeps its column layout. The next file
        with the same columns uses it with no questions.
      </Text>
      {error ? (
        <Banner tone="danger" icon="triangle-alert">
          <VStack gap="xs">
            <Text variant="caption" testID="saved-layouts-error">
              {error}
            </Text>
            <Button
              label="Try again"
              size="sm"
              variant="secondary"
              onPress={retry}
              testID="saved-layouts-retry"
            />
          </VStack>
        </Banner>
      ) : null}
      {layouts === null && !error ? (
        <Text variant="caption" tone="muted">
          Loading...
        </Text>
      ) : null}
      {layouts && layouts.length === 0 ? (
        <Card>
          <EmptyState
            icon="file-up"
            title="No saved layouts yet"
            message="They appear here after you import a bank CSV."
          />
        </Card>
      ) : null}
      {layouts && layouts.length > 0 ? (
        <Card padding="none">
          {layouts.map((l) => (
            <View key={l.signature} style={styles.row} testID={`layout-${l.signature}`}>
              <Text variant="bodyStrong" numberOfLines={1}>
                {l.name}
              </Text>
              <Text variant="caption" tone="muted" testID={`layout-meta-${l.signature}`}>
                {`${layoutAccountText(l.accountId, data.accounts)} · Last used ${formatShortDate(todayLocal(new Date(l.updatedAt)), today)}`}
              </Text>
              <Text variant="caption" tone="faint">
                {layoutColumnsText(l)}
              </Text>
            </View>
          ))}
        </Card>
      ) : null}
      {layouts && layouts.length > 0 ? (
        <Text variant="caption" tone="faint">
          Removing a saved layout is not possible from the app yet.
        </Text>
      ) : null}
    </VStack>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    gap: theme.space.xxs,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.md,
    borderBottomWidth: theme.size.hairline,
    borderColor: theme.colors.border,
  },
}));
