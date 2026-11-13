import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { RefreshControl } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { IconButton } from '../../design/components/Button';
import { Card } from '../../design/components/Card';
import { Badge } from '../../design/components/Controls';
import { Banner, EmptyState, IconBadge } from '../../design/components/Decor';
import { HStack } from '../../design/components/Layout';
import { ListRow } from '../../design/components/ListRow';
import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import { isBackendReady, useBackendConfig } from '../../data/backend/config';
import { BackAction } from '../planning/BackAction';
import { STATE_TONE } from './labels';
import { clearOpenedFiles } from './openStoredFile';
import { VAULT_LISTED } from './vaultApi';
import { fileState, formatLabel, sizeLabel, STATE_LABEL, storedFiles } from './vaultFiles';
import { loadVault, useVault } from './vaultStore';

/**
 * Stored statements: every file the Worker keeps in its vault (GET
 * /v1/vault), one row per file, newest first. A row opens the file's page.
 * Nothing can be changed here.
 */
export function VaultScreen() {
  const config = useBackendConfig();
  const ready = isBackendReady(config);
  const { records, loading, error } = useVault();
  const { theme } = useUnistyles();
  const [pulling, setPulling] = useState(false);

  useEffect(() => {
    // A copy left on the phone by an earlier "open" is not needed once you are back here.
    clearOpenedFiles();
    if (ready) void loadVault();
  }, [ready, config.scope]);

  if (!ready) {
    return (
      <Screen
        title="Stored statements"
        actions={<BackAction fallback="/accounts" />}
        testID="screen-vault"
      >
        <Card>
          <EmptyState
            icon="cloud-off"
            title="Set up the backend first"
            message="Statements are kept by your Worker. Enter its address and your API token in Settings, Backend."
          />
        </Card>
      </Screen>
    );
  }

  const files = records ? storedFiles(records) : null;
  return (
    <Screen
      title="Stored statements"
      actions={
        <HStack gap="xs">
          <IconButton
            icon="refresh-cw"
            accessibilityLabel="Reload the list"
            onPress={() => void loadVault()}
            testID="vault-reload"
          />
          <BackAction fallback="/accounts" />
        </HStack>
      }
      refreshControl={
        <RefreshControl
          refreshing={pulling}
          tintColor={theme.colors.accent}
          colors={[theme.colors.accent]}
          onRefresh={() => {
            setPulling(true);
            void loadVault().finally(() => setPulling(false));
          }}
        />
      }
      testID="screen-vault"
    >
      <Text variant="caption" tone="muted">
        Every file you gave the app to import is kept by your Worker as it was uploaded, whether or
        not you went on to import it. Undoing an import keeps its file.
      </Text>
      {error ? (
        <Banner tone="danger" icon="triangle-alert">
          <Text variant="caption" testID="vault-error">
            {error}
          </Text>
        </Banner>
      ) : null}
      {files === null ? (
        loading ? (
          <Text variant="caption" tone="muted" testID="vault-loading">
            Loading...
          </Text>
        ) : null
      ) : files.length === 0 ? (
        <Card>
          <EmptyState
            icon="paperclip"
            title="No stored files yet"
            message="A file is stored when you make a preview of it under Import a statement."
          />
        </Card>
      ) : (
        <>
          <Text variant="bodyStrong" testID="vault-count">
            {`${files.length} ${files.length === 1 ? 'file' : 'files'}`}
          </Text>
          {records && records.length >= VAULT_LISTED ? (
            <Text variant="caption" tone="pending" testID="vault-limit">
              {`Your Worker lists its newest ${VAULT_LISTED} stored copies, and every preview stores one. Older files are still kept but are not listed here.`}
            </Text>
          ) : null}
          <Card padding="none">
            {files.map((f) => {
              const state = fileState(f.record);
              return (
                <ListRow
                  key={f.id}
                  title={f.record.fileName}
                  subtitle={[
                    formatLabel(f.record.format),
                    sizeLabel(f.record.size),
                    `stored ${f.copies[0]!.createdAt.slice(0, 10)}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  leading={<IconBadge icon="paperclip" color="c5" />}
                  trailing={<Badge label={STATE_LABEL[state]} tone={STATE_TONE[state]} />}
                  onPress={() => router.push({ pathname: '/vault/[id]', params: { id: f.id } })}
                  showChevron
                  testID={`vault-file-${f.id}`}
                />
              );
            })}
          </Card>
        </>
      )}
    </Screen>
  );
}
