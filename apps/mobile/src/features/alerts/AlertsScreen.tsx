import { formatShortDate, type Alert } from '@manaclaude/shared';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { RefreshControl, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Button, IconButton } from '../../design/components/Button';
import { Card } from '../../design/components/Card';
import { Badge, type BadgeTone } from '../../design/components/Controls';
import { Banner, EmptyState } from '../../design/components/Decor';
import { HStack, VStack } from '../../design/components/Layout';
import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import { isBackendReady, useBackendConfig } from '../../data/backend/config';
import { useLookups, useToday } from '../../data/selectors';
import { Amount } from '../currency/Amount';
import { BackAction } from '../planning/BackAction';
import { ALERTS_LISTED } from './alertsApi';
import { dismiss, loadAlerts, useAlerts } from './alertsStore';

const KIND: Record<string, { label: string; tone: BadgeTone; amount: string }> = {
  duplicate: { label: 'Possible duplicate', tone: 'pending', amount: 'Charged' },
  unusual: { label: 'Unusual charge', tone: 'spending', amount: 'Charged' },
  price_increase: { label: 'Price went up', tone: 'accent', amount: 'More than before' },
};
/** A type this version of the app does not know yet still shows, with the Worker's message. */
const OTHER = { label: 'Alert', tone: 'neutral' as BadgeTone, amount: 'Amount' };

export function alertKind(type: string) {
  return KIND[type] ?? OTHER;
}

/**
 * Alerts the Worker raised: a charge that looks doubled, one far above the
 * usual for its merchant, a subscription that went up. Read-only apart from
 * Dismiss. The list is GET /v1/alerts (not yet dismissed, newest first).
 */
export function AlertsScreen() {
  const config = useBackendConfig();
  const ready = isBackendReady(config);
  const { alerts, loading, error, dismissing } = useAlerts();
  const lookups = useLookups();
  const today = useToday();
  const { theme } = useUnistyles();
  const [pulling, setPulling] = useState(false);

  useEffect(() => {
    if (ready) void loadAlerts();
  }, [ready, config.scope]);

  if (!ready) {
    return (
      <Screen title="Alerts" actions={<BackAction fallback="/" />} testID="screen-alerts">
        <Card>
          <EmptyState
            icon="cloud-off"
            title="Set up the backend first"
            message="Alerts are raised by your Worker. Enter its address and your API token in Settings, Backend."
          />
        </Card>
      </Screen>
    );
  }

  const row = (a: Alert) => {
    const kind = alertKind(a.type);
    const txn = a.transactionId ? lookups.transactionsById.get(a.transactionId) : undefined;
    const account = txn ? lookups.accountsById.get(txn.accountId) : undefined;
    const busy = dismissing.includes(a.id);
    return (
      <View key={a.id} style={styles.row} testID={`alert-${a.id}`}>
        <HStack gap="sm" justify="space-between" align="center">
          <Badge label={kind.label} tone={kind.tone} />
          <Text variant="caption" tone="muted">
            {formatShortDate(a.createdAt.slice(0, 10), today)}
          </Text>
        </HStack>
        <Text variant="body">{a.message}</Text>
        {a.amount !== null && a.currency ? (
          <HStack gap="xs" align="baseline">
            <Text variant="caption" tone="muted">
              {kind.amount}
            </Text>
            <Amount amount={a.amount} currency={a.currency} size="small" align="left" />
          </HStack>
        ) : null}
        {txn ? (
          <Text variant="caption" tone="muted" numberOfLines={1}>
            {[txn.name || txn.rawName, formatShortDate(txn.date, today), account?.name]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        ) : a.transactionId ? (
          <Text variant="caption" tone="faint" testID={`alert-no-transaction-${a.id}`}>
            Its transaction is not in the data loaded on this device, so it cannot be opened from
            here.
          </Text>
        ) : null}
        <HStack gap="sm" wrap>
          {txn ? (
            <Button
              label="See the transaction"
              size="sm"
              variant="secondary"
              onPress={() =>
                router.push({ pathname: '/transactions/[id]', params: { id: txn.id } })
              }
              testID={`alert-open-${a.id}`}
            />
          ) : null}
          {a.recurringId ? (
            <Button
              label="See recurring"
              size="sm"
              variant="secondary"
              onPress={() => router.navigate('/recurring')}
              testID={`alert-recurring-${a.id}`}
            />
          ) : null}
          <Button
            label="Dismiss"
            size="sm"
            variant="ghost"
            loading={busy}
            onPress={() => void dismiss(a.id)}
            testID={`alert-dismiss-${a.id}`}
          />
        </HStack>
      </View>
    );
  };

  return (
    <Screen
      title="Alerts"
      actions={
        <HStack gap="xs">
          <IconButton
            icon="refresh-cw"
            accessibilityLabel="Reload alerts"
            onPress={() => void loadAlerts()}
            testID="alerts-reload"
          />
          <BackAction fallback="/" />
        </HStack>
      }
      refreshControl={
        <RefreshControl
          refreshing={pulling}
          tintColor={theme.colors.accent}
          colors={[theme.colors.accent]}
          onRefresh={() => {
            setPulling(true);
            void loadAlerts().finally(() => setPulling(false));
          }}
        />
      }
      testID="screen-alerts"
    >
      {error ? (
        <Banner tone="danger" icon="triangle-alert">
          <Text variant="caption" testID="alerts-error">
            {error}
          </Text>
        </Banner>
      ) : null}
      {alerts === null ? (
        loading ? (
          <Text variant="caption" tone="muted" testID="alerts-loading">
            Loading...
          </Text>
        ) : null
      ) : alerts.length === 0 ? (
        <Card>
          <EmptyState
            icon="bell"
            title="No alerts"
            message="Your Worker looks once a day for a charge that appears twice, one far above the usual for that merchant, and a subscription that went up. What it finds is listed here."
          />
        </Card>
      ) : (
        <>
          <VStack gap="xxs">
            <Text variant="bodyStrong" testID="alerts-count">
              {`${alerts.length} ${alerts.length === 1 ? 'alert' : 'alerts'}`}
            </Text>
            <Text variant="caption" tone="muted">
              {`Each one is a hint to check, not a finding. A dismissed alert does not come back.${
                alerts.length >= ALERTS_LISTED
                  ? ` These are the newest ${ALERTS_LISTED}; older ones show as you dismiss these.`
                  : ''
              }`}
            </Text>
          </VStack>
          <Card padding="none">{alerts.map(row)}</Card>
        </>
      )}
    </Screen>
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
}));
