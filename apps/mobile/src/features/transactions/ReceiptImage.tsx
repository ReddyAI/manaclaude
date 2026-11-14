import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, View } from 'react-native';
import type { Receipt } from '@manaclaude/shared';
import { StyleSheet } from 'react-native-unistyles';
import { Button } from '../../design/components/Button';
import { Icon } from '../../design/components/Icon';
import { VStack } from '../../design/components/Layout';
import { Text } from '../../design/components/Text';
import { errorText, fetchImageData, isSuperseded } from '../../data/backend/client';
import { useBackendConfig } from '../../data/backend/config';
import { useBackendStatus } from '../../data/backend/status';
import { canSaveToBackend } from '../../data/backend/sync';
import { isOnWorker } from './receiptInbox';

/**
 * A receipt's photo. The copy on this device when there is one; otherwise it
 * is read from the Worker (GET /v1/receipts/:id/image) into memory and
 * dropped when this view closes. Nothing is written to the device.
 */
export function ReceiptImage({
  receipt,
  compact = false,
  testID,
}: {
  receipt: Receipt;
  /** Shorter, to leave room below it (the attach sheet). */
  compact?: boolean;
  testID?: string;
}) {
  const config = useBackendConfig();
  useBackendStatus();
  const local = receipt.localUri ?? null;
  const fromWorker = !local && isOnWorker(receipt) && canSaveToBackend();
  const key = fromWorker ? `${receipt.id}|${config.scope}` : '';
  const [state, setState] = useState<{
    key: string;
    uri: string | null;
    error: string | null;
    tries: number;
  }>({ key, uri: null, error: null, tries: 0 });
  if (state.key !== key) setState({ key, uri: null, error: null, tries: 0 });

  useEffect(() => {
    if (!key) return;
    let open = true;
    fetchImageData(`/v1/receipts/${encodeURIComponent(receipt.id)}/image`, { timeoutMs: 60_000 })
      .then((uri) => {
        if (open) setState((s) => (s.key === key ? { ...s, uri, error: null } : s));
      })
      .catch((e: unknown) => {
        if (!open || isSuperseded(e)) return;
        setState((s) => (s.key === key ? { ...s, error: errorText(e) } : s));
      });
    return () => {
      // The picture lives only in this view's state; closing it lets the string go.
      open = false;
    };
  }, [key, receipt.id, state.tries]);

  const uri = local ?? (state.key === key ? state.uri : null);
  if (uri)
    return (
      <Image
        source={{ uri }}
        style={compact ? styles.compact : styles.image}
        resizeMode="contain"
        accessibilityLabel="Receipt photo"
        testID={testID}
      />
    );
  if (!fromWorker)
    return (
      <View style={styles.box} testID={testID ? `${testID}-none` : undefined}>
        <Icon name="receipt" size="lg" tone="faint" />
        <Text variant="caption" tone="muted" align="center">
          {"The photo is not on this device, and your Worker's data is not loaded."}
        </Text>
      </View>
    );
  if (state.error)
    return (
      <VStack gap="sm" align="center" testID={testID ? `${testID}-error` : undefined}>
        <Text variant="caption" tone="danger" align="center">
          {`The photo could not be loaded from your Worker. ${state.error}`}
        </Text>
        <Button
          label="Try again"
          variant="secondary"
          size="sm"
          onPress={() => setState((s) => ({ ...s, error: null, tries: s.tries + 1 }))}
        />
      </VStack>
    );
  return (
    <View style={styles.box} testID={testID ? `${testID}-loading` : undefined}>
      <ActivityIndicator />
      <Text variant="caption" tone="muted">
        Loading the photo from your Worker...
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme, rt) => ({
  image: { width: '100%', height: rt.screen.height * 0.6 },
  compact: { width: '100%', height: rt.screen.height * 0.3 },
  box: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space.sm,
    padding: theme.space.xl,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceSunken,
  },
}));
