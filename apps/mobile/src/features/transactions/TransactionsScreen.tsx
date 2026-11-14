import { FlashList } from '@shopify/flash-list';
import { useBackendStatus } from '../../data/backend/status';
import { canSaveToBackend } from '../../data/backend/sync';
import { useRefreshControl } from '../../data/backend/useRefreshControl';
import { useMemo, useState } from 'react';
import { useWindowDimensions, View } from 'react-native';
import type { Transaction } from '@manaclaude/shared';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Chip, TextField } from '../../design/components/Controls';
import { EmptyState } from '../../design/components/Decor';
import { HStack } from '../../design/components/Layout';
import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import { breakpoints } from '../../design/themes';
import { useLookups, useToday } from '../../data/selectors';
import { useFinance } from '../../data/store';
import { CurrencyChip } from '../currency/CurrencyChip';
import { goTo } from '../planning/navigate';
import { CashQuickAddButton } from './CashQuickAdd';
import { groupByDay } from './display';
import { ReviewQueueList } from './ReviewQueue';
import { reviewCount } from './reviewQueue';
import { TransactionDetailSheet } from './TransactionDetailSheet';
import { TransactionRow } from './TransactionRow';
import { TransactionsTable } from './TransactionsTable';
import { receiptsToAttach } from './receiptInbox';
import { openSuggestions } from './transfers';

type Filter = 'all' | 'review' | 'pending';

/**
 * Transactions (session A owns this screen): search, filters, the day-grouped
 * list (a table on wide Compact screens), the review queue with swipes, and the
 * cash quick-add button.
 */
export function TransactionsScreen() {
  const refreshControl = useRefreshControl();
  useBackendStatus();
  const data = useFinance();
  const lookups = useLookups();
  const today = useToday();
  const { theme } = useUnistyles();
  const { width } = useWindowDimensions();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<Transaction | null>(null);
  const table = theme.layout.denseTables && width >= breakpoints.md;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.transactions.filter((t) => {
      if (filter === 'pending' && !t.pending) return false;
      if (!q) return true;
      const category = t.categoryId ? lookups.categoriesById.get(t.categoryId)?.name : '';
      return `${t.name} ${t.rawName} ${category ?? ''}`.toLowerCase().includes(q);
    });
  }, [data.transactions, filter, query, lookups]);

  const items = useMemo(() => groupByDay(filtered, lookups, today), [filtered, lookups, today]);
  const toReview = useMemo(
    () => reviewCount(data.transactions, lookups),
    [data.transactions, lookups],
  );
  const reviewing = filter === 'review';
  const possible = useMemo(() => openSuggestions(data).length, [data]);
  const toAttach = useMemo(() => receiptsToAttach(data).length, [data]);

  return (
    <Screen
      title="Transactions"
      actions={<CurrencyChip />}
      scroll={false}
      overlay={<CashQuickAddButton />}
      testID="screen-transactions"
    >
      <View style={styles.controls}>
        {reviewing ? null : (
          <TextField
            icon="search"
            placeholder="Search name, category or bank text"
            value={query}
            onChangeText={setQuery}
            accessibilityLabel="Search transactions"
          />
        )}
        <HStack gap="sm" wrap>
          <Chip label="All" selected={filter === 'all'} onPress={() => setFilter('all')} />
          <Chip
            label={`To review · ${toReview}`}
            selected={filter === 'review'}
            onPress={() => setFilter('review')}
          />
          <Chip
            label="Pending"
            selected={filter === 'pending'}
            onPress={() => setFilter('pending')}
          />
          {possible > 0 ? (
            <Chip
              label={`Possible transfers · ${possible}`}
              icon="link"
              onPress={() => goTo('/transactions/transfers')}
              testID="open-possible-transfers"
            />
          ) : null}
          {toAttach > 0 && canSaveToBackend() ? (
            <Chip
              label={`Receipts to attach · ${toAttach}`}
              icon="receipt"
              onPress={() => goTo('/transactions/receipts')}
              testID="open-receipts-to-attach"
            />
          ) : null}
        </HStack>
      </View>
      {reviewing ? (
        <ReviewQueueList />
      ) : items.length === 0 ? (
        <EmptyState
          icon="search"
          title="Nothing matches"
          message="Try a different search or filter."
        />
      ) : table ? (
        <TransactionsTable transactions={filtered} lookups={lookups} onOpen={setOpen} />
      ) : (
        <FlashList
          data={items}
          refreshControl={refreshControl}
          keyExtractor={(i) => i.key}
          getItemType={(i) => i.type}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) =>
            item.type === 'header' ? (
              <View style={styles.dayHeader}>
                <Text variant="label" tone="muted">
                  {item.title}
                </Text>
              </View>
            ) : (
              <TransactionRow row={item} lookups={lookups} onPress={() => setOpen(item.txn)} />
            )
          }
        />
      )}
      <TransactionDetailSheet txn={open} lookups={lookups} onClose={() => setOpen(null)} />
    </Screen>
  );
}

const styles = StyleSheet.create((theme, rt) => ({
  controls: {
    gap: theme.space.md,
    paddingHorizontal: { xs: theme.space.lg, md: theme.space.xl },
    paddingBottom: theme.space.md,
  },
  listContent: { paddingBottom: rt.insets.bottom + theme.size.tabBarHeight + theme.space.xl },
  dayHeader: {
    paddingHorizontal: theme.space.lg,
    paddingTop: theme.space.lg,
    paddingBottom: theme.space.xs,
    backgroundColor: theme.colors.canvas,
  },
}));
