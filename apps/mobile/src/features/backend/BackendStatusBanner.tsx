import { useEffect } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Button, IconButton } from '../../design/components/Button';
import { Icon } from '../../design/components/Icon';
import { Text } from '../../design/components/Text';
import {
  dismissBackendError,
  refreshDataset,
  startBackend,
  useBackendStatus,
} from '../../data/backend/sync';

/**
 * Starts the backend loader once, and shows its errors on every screen: a
 * strip above the tab bar with the plain message, Retry and close. The data
 * on screen stays as it was (the last loaded copy).
 */
export function BackendStatusBanner() {
  const status = useBackendStatus();
  useEffect(() => {
    void startBackend();
  }, []);
  if (!status.error) return null;
  return (
    <View style={styles.wrap} pointerEvents="box-none">
      <View style={styles.banner} accessibilityRole="alert" testID="backend-error">
        <Icon name="cloud-off" size="sm" tone="danger" />
        <Text variant="caption" style={styles.text}>
          {status.error}
        </Text>
        {status.mode === 'live' ? (
          <Button label="Retry" size="sm" variant="ghost" onPress={() => void refreshDataset()} />
        ) : null}
        <IconButton icon="x" accessibilityLabel="Close" onPress={dismissBackendError} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme, rt) => ({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: rt.insets.bottom + theme.size.tabBarHeight + theme.space.sm,
    alignItems: 'center',
    paddingHorizontal: theme.space.lg,
  },
  banner: {
    width: '100%',
    maxWidth: theme.size.maxContentWidth,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.sm,
    paddingVertical: theme.space.sm,
    paddingLeft: theme.space.md,
    paddingRight: theme.space.xs,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surfaceRaised,
    borderWidth: theme.size.hairline,
    borderColor: theme.colors.danger,
  },
  text: { flex: 1 },
}));
