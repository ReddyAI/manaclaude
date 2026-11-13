import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Button } from '../../design/components/Button';
import { Card } from '../../design/components/Card';
import { Badge } from '../../design/components/Controls';
import { Banner, EmptyState } from '../../design/components/Decor';
import { HStack, VStack } from '../../design/components/Layout';
import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import { errorText } from '../../data/backend/client';
import { isBackendReady, useBackendConfig } from '../../data/backend/config';
import { useLookups } from '../../data/selectors';
import { BackAction } from '../planning/BackAction';
import { importSentence, STATE_TONE } from './labels';
import { OPEN_HINT, OPEN_LABEL, openStoredFile } from './openStoredFile';
import { vaultFileText } from './vaultApi';
import {
  excerpt,
  fileState,
  findStoredFile,
  formatLabel,
  importsOf,
  isTextFile,
  sizeLabel,
  STATE_LABEL,
  storedFiles,
  type TextExcerpt,
} from './vaultFiles';
import { loadVault, useVault } from './vaultStore';

interface Shown {
  /** The backend and file this belongs to. */
  key: string;
  text: TextExcerpt | null;
  error: string | null;
  note: string | null;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <HStack gap="md" justify="space-between" align="flex-start">
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <Text variant="caption" align="right" style={styles.value}>
        {value}
      </Text>
    </HStack>
  );
}

/**
 * /vault/<id>: one stored file. What it is, what was done with it, its text
 * on screen when it is a text file (CSV, OFX, QIF), and a way to open or
 * save the original (GET /v1/vault/:id/file). Nothing can be changed here.
 */
export function VaultFileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const config = useBackendConfig();
  const ready = isBackendReady(config);
  const { records, loading, error: listError } = useVault();
  const lookups = useLookups();
  // What was read or reported, with the backend and file it belongs to. After
  // a change of either, the old result is simply not this page's any more.
  const key = `${config.scope}|${id ?? ''}`;
  const [shown, setShown] = useState<Shown>({ key, text: null, error: null, note: null });
  const { text, error, note } = shown.key === key ? shown : { text: null, error: null, note: null };
  const [busy, setBusy] = useState<'text' | 'open' | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (ready && records === null) void loadVault();
  }, [ready, records, config.scope]);

  const file = records && id ? findStoredFile(storedFiles(records), id) : null;
  const back = <BackAction fallback="/vault" />;

  if (!ready || !file) {
    return (
      <Screen title="Stored file" actions={back} testID="screen-vault-file">
        {listError ? (
          <Banner tone="danger" icon="triangle-alert">
            <Text variant="caption" testID="vault-file-error">
              {listError}
            </Text>
          </Banner>
        ) : null}
        {!ready ? (
          <Card>
            <EmptyState
              icon="cloud-off"
              title="Set up the backend first"
              message="Statements are kept by your Worker. Enter its address and your API token in Settings, Backend."
            />
          </Card>
        ) : records === null ? (
          loading ? (
            <Text variant="caption" tone="muted">
              Loading...
            </Text>
          ) : null
        ) : (
          <Card>
            <EmptyState
              icon="search"
              title="File not found"
              message="It is not among the files your Worker lists."
              actionLabel="Stored statements"
              onAction={() => router.replace('/vault')}
            />
          </Card>
        )}
      </Screen>
    );
  }

  const { record } = file;
  const state = fileState(record);
  const imports = importsOf(file);
  const unsaved = file.copies.length - imports.length;
  const account = record.accountId ? lookups.accountsById.get(record.accountId) : undefined;

  const run = async (kind: 'text' | 'open', work: () => Promise<Partial<Shown>>) => {
    if (busy) return;
    setBusy(kind);
    // Results are filed under the page they were asked from.
    const base: Shown = { key, text, error: null, note: null };
    setShown(base);
    try {
      const result = await work();
      if (alive.current) setShown({ ...base, ...result });
    } catch (e) {
      if (alive.current) setShown({ ...base, error: errorText(e) });
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const showText = () =>
    run('text', async () => ({ text: excerpt(await vaultFileText(record.id)) }));

  const open = () =>
    run('open', async () => {
      const result = await openStoredFile(record);
      if (result === 'no_app')
        return {
          note: isTextFile(record)
            ? 'No app on this phone opens this kind of file. You can read it here with Show the contents.'
            : 'No app on this phone opens this kind of file. Install a PDF viewer, or open the web app on a computer and download it there.',
        };
      if (result === 'downloaded')
        return { note: `${record.fileName} was handed to your browser.` };
      return {};
    });

  return (
    <Screen title="Stored file" actions={back} testID="screen-vault-file">
      {error ? (
        <Banner tone="danger" icon="triangle-alert">
          <Text variant="caption" testID="vault-file-error">
            {error}
          </Text>
        </Banner>
      ) : null}
      {note ? (
        <Banner tone="accent" icon="info">
          <Text variant="caption" testID="vault-file-note">
            {note}
          </Text>
        </Banner>
      ) : null}
      <Card>
        <VStack gap="sm">
          <HStack gap="sm" justify="space-between" align="flex-start">
            <Text variant="headline" style={styles.value} testID="vault-file-name">
              {record.fileName}
            </Text>
            <Badge label={STATE_LABEL[state]} tone={STATE_TONE[state]} />
          </HStack>
          <Fact label="Kind" value={formatLabel(record.format)} />
          <Fact label="Size" value={sizeLabel(record.size)} />
          <Fact label="First stored" value={file.copies.at(-1)!.createdAt.slice(0, 10)} />
          {record.periodStart && record.periodEnd ? (
            <Fact label="Statement period" value={`${record.periodStart} to ${record.periodEnd}`} />
          ) : null}
          {account ? <Fact label="Imported into" value={account.name} /> : null}
        </VStack>
      </Card>

      <Card>
        <VStack gap="xs" testID="vault-file-history">
          <Text variant="label" tone="muted">
            What was done with it
          </Text>
          {imports.map((r) => (
            <VStack key={r.id} gap="xxs">
              <Text variant="caption">{importSentence(r)}</Text>
              {r.error ? (
                <Text variant="caption" tone="pending">
                  {r.error}
                </Text>
              ) : null}
            </VStack>
          ))}
          {imports.length === 0 ? (
            <Text variant="caption">It was previewed and never imported.</Text>
          ) : null}
          {unsaved > 0 && imports.length > 0 ? (
            <Text variant="caption" tone="faint">
              {`It was also previewed ${unsaved} more ${unsaved === 1 ? 'time' : 'times'} without importing.`}
            </Text>
          ) : null}
          <Text variant="caption" tone="faint">
            To undo an import, use Import a statement, History.
          </Text>
        </VStack>
      </Card>

      <Card>
        <VStack gap="sm">
          <HStack gap="sm" wrap>
            {isTextFile(record) ? (
              <Button
                label={text ? 'Read it again' : 'Show the contents'}
                size="sm"
                variant={text ? 'secondary' : 'primary'}
                loading={busy === 'text'}
                disabled={busy === 'open'}
                onPress={() => void showText()}
                testID="vault-file-show"
              />
            ) : null}
            <Button
              label={OPEN_LABEL}
              size="sm"
              icon="external-link"
              variant={isTextFile(record) ? 'secondary' : 'primary'}
              loading={busy === 'open'}
              disabled={busy === 'text'}
              onPress={() => void open()}
              testID="vault-file-open"
            />
          </HStack>
          <Text variant="caption" tone="faint">
            {isTextFile(record)
              ? `Show the contents reads the file here, without saving it on this device. ${OPEN_HINT}`
              : `A PDF cannot be shown inside the app. ${OPEN_HINT}`}
          </Text>
        </VStack>
      </Card>

      {text ? (
        <Card padding="none">
          <View style={styles.textHead}>
            <Text variant="label" tone="muted" testID="vault-file-lines">
              {text.total === 0
                ? 'The file is empty'
                : text.total > text.lines.length
                  ? `First ${text.lines.length} of ${text.total} lines`
                  : `${text.total} ${text.total === 1 ? 'line' : 'lines'}`}
            </Text>
          </View>
          <View style={styles.text} testID="vault-file-text">
            {text.lines.map((line, i) => (
              // Lines of a statement repeat; the position is what names one.
              <Text key={i} variant="caption" numeric selectable>
                {line || ' '}
              </Text>
            ))}
          </View>
        </Card>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create((theme) => ({
  value: { flex: 1 },
  textHead: { paddingHorizontal: theme.space.lg, paddingTop: theme.space.md },
  text: {
    gap: theme.space.xxs,
    padding: theme.space.lg,
  },
}));
