import { FlashList } from '@shopify/flash-list';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { classifyAccountType, type Transaction } from '@manaclaude/shared';
import { StyleSheet } from 'react-native-unistyles';
import { Badge } from '../../design/components/Controls';
import { Card } from '../../design/components/Card';
import { EmptyState } from '../../design/components/Decor';
import { HStack, VStack } from '../../design/components/Layout';
import { IconButton } from '../../design/components/Button';
import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import { useLookups, useToday } from '../../data/selectors';
import { useFinance } from '../../data/store';
import { Amount } from '../currency/Amount';
import { CurrencyChip } from '../currency/CurrencyChip';
import { groupByDay } from '../transactions/display';
import { TransactionDetailSheet } from '../transactions/TransactionDetailSheet';
import { TransactionRow } from '../transactions/TransactionRow';
import { connectionHealth, lastSyncText } from './health';

/** /accounts/<id>: one account's balance, connection health and its transactions. */
export function AccountDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const data = useFinance();
  const lookups = useLookups();
  const today = useToday();
  const [open, setOpen] = useState<Transaction | null>(null);
  const account = data.accounts.find((a) => a.id === id);
  const connection = account?.connectionId
    ? data.connections.find((c) => c.id === account.connectionId)
    : undefined;
  const items = useMemo(
    () =>
      account
        ? groupByDay(
            data.transactions.filter((t) => t.accountId === account.id),
            lookups,
            today,
            { bothSides: true },
          )
        : [],
    [account, data.transactions, lookups, today],
  );
  const back = () => (router.canGoBack() ? router.back() : router.replace('/accounts'));

  if (!account) {
    return (
      <Screen title="Account" actions={<CurrencyChip />} testID="screen-account">
        <EmptyState
          icon="wallet"
          title="Account not found"
          actionLabel="Back to accounts"
          onAction={back}
        />
      </Screen>
    );
  }

  const liability = classifyAccountType(account.type) === 'liability';
  const health = connection ? connectionHealth(connection) : null;

  return (
    <Screen
      title={account.name}
      subtitle={[account.institutionName, account.mask ? `••${account.mask}` : null]
        .filter(Boolean)
        .join(' · ')}
      actions={
        <>
          <IconButton icon="chevron-left" onPress={back} accessibilityLabel="Back to accounts" />
          <CurrencyChip />
        </>
      }
      scroll={false}
      testID="screen-account"
    >
      <FlashList
        data={items}
        keyExtractor={(i) => i.key}
        getItemType={(i) => i.type}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          <View style={styles.header}>
            <Card>
              <VStack gap="xs" align="center">
                <Text variant="label" tone="muted">
                  {liability ? 'Owed' : 'Balance'}
                </Text>
                <Amount
                  amount={liability ? -account.balance : account.balance}
                  currency={account.currency}
                  size="hero"
                  align="center"
                  testID="account-balance"
                />
                {health ? (
                  <HStack justify="center">
                    <Badge label={health.label} tone={health.tone} />
                  </HStack>
                ) : null}
                <Text variant="caption" tone="muted">
                  {connection
                    ? lastSyncText(connection.lastSyncAt)
                    : 'Manual account, no connector'}
                </Text>
              </VStack>
            </Card>
          </View>
        }
        ListEmptyComponent={
          <EmptyState
            icon="list"
            title="No transactions"
            message="Nothing has been recorded here yet."
          />
        }
        renderItem={({ item }) =>
          item.type === 'header' ? (
            <View style={styles.dayHeader}>
              <Text variant="label" tone="muted">
                {item.title}
              </Text>
            </View>
          ) : (
            <TransactionRow
              row={item}
              lookups={lookups}
              onPress={() => setOpen(item.txn)}
              signedTransfers
            />
          )
        }
      />
      <TransactionDetailSheet txn={open} lookups={lookups} onClose={() => setOpen(null)} />
    </Screen>
  );
}

const styles = StyleSheet.create((theme, rt) => ({
  header: { paddingHorizontal: { xs: theme.space.lg, md: theme.space.xl } },
  listContent: { paddingBottom: rt.insets.bottom + theme.size.tabBarHeight + theme.space.xl },
  dayHeader: {
    paddingHorizontal: theme.space.lg,
    paddingTop: theme.space.lg,
    paddingBottom: theme.space.xs,
    backgroundColor: theme.colors.canvas,
  },
}));
