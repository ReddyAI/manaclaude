import { FlashList } from '@shopify/flash-list';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { classifyAccountType, formatMoney, type Transaction } from '@manaclaude/shared';
import { StyleSheet } from 'react-native-unistyles';
import { Badge } from '../../design/components/Controls';
import { Card } from '../../design/components/Card';
import { EmptyState } from '../../design/components/Decor';
import { HStack, VStack } from '../../design/components/Layout';
import { Button, IconButton } from '../../design/components/Button';
import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import { isBackendReady, useBackendConfig } from '../../data/backend/config';
import { useBackendStatus } from '../../data/backend/status';
import { canSaveToBackend } from '../../data/backend/sync';
import { isBalanceUnknown, manualBalanceOf } from '../../data/manualBalance';
import { useLookups, useToday } from '../../data/selectors';
import { useFinance } from '../../data/store';
import { Amount } from '../currency/Amount';
import { CurrencyChip } from '../currency/CurrencyChip';
import { groupByDay } from '../transactions/display';
import { TransactionDetailSheet } from '../transactions/TransactionDetailSheet';
import { TransactionRow } from '../transactions/TransactionRow';
import { AccountEditSheet } from './AccountEditSheet';
import { isProviderAccount, readOnlyReason } from './accountEdit';
import { connectionHealth, lastSyncText } from './health';
import { RemoveAccountSheet } from './RemoveAccountSheet';

/** /accounts/<id>: one account's balance, connection health and its transactions. */
export function AccountDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const data = useFinance();
  const lookups = useLookups();
  const today = useToday();
  const [open, setOpen] = useState<Transaction | null>(null);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removedNote, setRemovedNote] = useState<string | null>(null);
  const ready = isBackendReady(useBackendConfig());
  useBackendStatus();
  // Edits go to the Worker, so its data (not the sample data) must be on screen.
  const live = ready && canSaveToBackend();
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
          title={removedNote ? 'Account removed' : 'Account not found'}
          message={removedNote ?? undefined}
          actionLabel="Back to accounts"
          onAction={back}
        />
      </Screen>
    );
  }

  const liability = classifyAccountType(account.type) === 'liability';
  const health = connection ? connectionHealth(connection) : null;
  const manual = manualBalanceOf(account);

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
                {isBalanceUnknown(account) ? (
                  <VStack gap="xxs" align="center">
                    <Text variant="headline" testID="account-balance-unknown">
                      Unknown
                    </Text>
                    <Text variant="caption" tone="muted" align="center">
                      No balance has been entered for this account, so it is kept out of net worth.
                      Imported rows do not change that.
                    </Text>
                  </VStack>
                ) : (
                  <Amount
                    amount={liability ? -account.balance : account.balance}
                    currency={account.currency}
                    size="hero"
                    align="center"
                    testID="account-balance"
                  />
                )}
                {manual?.currentKnown ? (
                  <Text variant="caption" tone="muted" testID="account-balance-as-of">
                    {`Entered by hand, as of ${account.balanceAsOf.slice(0, 10)}`}
                  </Text>
                ) : null}
                {manual?.openingBalance ? (
                  <Text variant="caption" tone="muted" testID="account-opening-balance">
                    {`Opening balance ${formatMoney(manual.openingBalance.amount, account.currency)} on ${manual.openingBalance.date}`}
                  </Text>
                ) : null}
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
                {isProviderAccount(account) ? (
                  <Text variant="caption" tone="muted" align="center" testID="account-read-only">
                    {readOnlyReason(account, data.connections)}
                  </Text>
                ) : live ? (
                  <HStack gap="sm" justify="center">
                    <Button
                      label="Edit"
                      icon="sliders-horizontal"
                      variant="secondary"
                      size="sm"
                      onPress={() => setEditing(true)}
                      testID="account-edit"
                    />
                    <Button
                      label="Remove"
                      variant="ghost"
                      size="sm"
                      onPress={() => setRemoving(true)}
                      testID="account-remove"
                    />
                  </HStack>
                ) : (
                  <Text
                    variant="caption"
                    tone="faint"
                    align="center"
                    testID="account-edit-needs-backend"
                  >
                    {ready
                      ? 'To edit or remove this account, pull down on Accounts to load your data from your Worker first.'
                      : 'Accounts are edited and removed on your Worker. Set it up in Settings, Backend.'}
                  </Text>
                )}
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
      {!isProviderAccount(account) && live ? (
        <>
          <AccountEditSheet
            accountId={account.id}
            visible={editing}
            onClose={() => setEditing(false)}
          />
          <RemoveAccountSheet
            accountId={account.id}
            visible={removing}
            onClose={() => setRemoving(false)}
            onRemoved={(note) => {
              setRemoving(false);
              setRemovedNote(note);
            }}
          />
        </>
      ) : null}
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
