import { FlashList } from '@shopify/flash-list';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import type { Transaction } from '@manaclaude/shared';
import { StyleSheet } from 'react-native-unistyles';
import { IconButton } from '../../design/components/Button';
import { Banner, EmptyState } from '../../design/components/Decor';
import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import { useLookups } from '../../data/selectors';
import { useFinance } from '../../data/store';
import { CurrencyChip } from '../currency/CurrencyChip';
import { CashQuickAddButton } from './CashQuickAdd';
import { setReviewed } from './actions';
import { buildReviewQueue, type ReviewItem } from './reviewQueue';
import { skipReview, useSkippedReviews } from './reviewSkips';
import { SwipeableReviewRow } from './SwipeableReviewRow';
import { TransactionDetailSheet } from './TransactionDetailSheet';

/**
 * The review queue list: lowest AI confidence first, swipe right to mark
 * reviewed, swipe left to skip. Used inside the Transactions screen and on
 * its own at /transactions/review.
 */
export function ReviewQueueList() {
  const data = useFinance();
  const lookups = useLookups();
  const skipped = useSkippedReviews();
  const [open, setOpen] = useState<Transaction | null>(null);
  const queue = useMemo(
    () => buildReviewQueue(data.transactions, lookups, skipped),
    [data.transactions, lookups, skipped],
  );
  const skippedCount = queue.filter((i) => i.skipped).length;

  if (queue.length === 0) {
    return (
      <EmptyState
        icon="check"
        title="All caught up"
        message="Nothing left to review. New transactions show up here with the AI's confidence."
      />
    );
  }

  return (
    <View style={styles.fill}>
      <View style={styles.intro}>
        <Banner icon="sparkles">
          <Text variant="caption" tone="muted">
            Least certain first. Swipe right to mark reviewed, left to skip.
            {skippedCount > 0 ? ` ${skippedCount} skipped, shown last.` : ''}
          </Text>
        </Banner>
      </View>
      <FlashList<ReviewItem>
        data={queue}
        keyExtractor={(i) => i.txn.id}
        contentContainerStyle={styles.listContent}
        testID="review-queue"
        renderItem={({ item }) => (
          <SwipeableReviewRow
            item={item}
            lookups={lookups}
            onReviewed={(i) => setReviewed(i.txn.id, true)}
            onSkip={(i) => skipReview(i.txn.id)}
            onOpen={(i) => setOpen(i.txn)}
          />
        )}
      />
      <TransactionDetailSheet txn={open} lookups={lookups} onClose={() => setOpen(null)} />
    </View>
  );
}

/** Stand-alone review screen (route /transactions/review). */
export function ReviewQueueScreen() {
  return (
    <Screen
      title="Review"
      subtitle="Lowest confidence first"
      actions={
        <>
          <IconButton
            icon="chevron-left"
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/transactions'))}
            accessibilityLabel="Back to transactions"
          />
          <CurrencyChip />
        </>
      }
      scroll={false}
      overlay={<CashQuickAddButton />}
      testID="screen-review"
    >
      <ReviewQueueList />
    </Screen>
  );
}

const styles = StyleSheet.create((theme, rt) => ({
  fill: { flex: 1 },
  intro: {
    paddingHorizontal: { xs: theme.space.lg, md: theme.space.xl },
    paddingBottom: theme.space.sm,
  },
  listContent: { paddingBottom: rt.insets.bottom + theme.size.tabBarHeight + theme.space.xxxl },
}));
