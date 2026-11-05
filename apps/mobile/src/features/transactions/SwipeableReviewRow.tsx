import { useRef } from 'react';
import { View } from 'react-native';
import ReanimatedSwipeable, {
  SwipeDirection,
  type SwipeableMethods,
} from 'react-native-gesture-handler/ReanimatedSwipeable';
import { StyleSheet } from 'react-native-unistyles';
import { Icon } from '../../design/components/Icon';
import { Text } from '../../design/components/Text';
import { haptic } from '../../design/haptics';
import type { Lookups } from '../../data/selectors';
import { ConfidencePill } from './ConfidencePill';
import type { ReviewItem } from './reviewQueue';
import { TransactionRow } from './TransactionRow';

export interface SwipeableReviewRowProps {
  item: ReviewItem;
  lookups: Lookups;
  /** Swipe right. */
  onReviewed: (item: ReviewItem) => void;
  /** Swipe left. */
  onSkip: (item: ReviewItem) => void;
  onOpen: (item: ReviewItem) => void;
}

/**
 * One row of the review queue. Swipe right marks it reviewed (confirm
 * haptic), swipe left skips it (it moves to the end of the queue).
 * Uses Gesture Handler's ReanimatedSwipeable.
 */
export function SwipeableReviewRow({
  item,
  lookups,
  onReviewed,
  onSkip,
  onOpen,
}: SwipeableReviewRowProps) {
  const swipeable = useRef<SwipeableMethods>(null);

  const handleOpen = (direction: SwipeDirection) => {
    // Swiping right slides the content right and reveals the left panel.
    if (direction === SwipeDirection.RIGHT) {
      haptic('confirm');
      onReviewed(item);
    } else {
      haptic('tap');
      onSkip(item);
    }
    // Rows are recycled by the list; never hand a half-open row to the next item.
    swipeable.current?.close();
  };

  return (
    <View
      accessible
      accessibilityLabel={`${item.title}, ${item.subtitle}. ${item.skipped ? 'Skipped. ' : ''}Swipe right to mark reviewed, left to skip.`}
      accessibilityActions={[
        { name: 'reviewed', label: 'Mark reviewed' },
        { name: 'skip', label: 'Skip' },
        { name: 'activate', label: 'Open details' },
      ]}
      onAccessibilityAction={(e) => {
        const action = e.nativeEvent.actionName;
        if (action === 'reviewed') handleOpen(SwipeDirection.RIGHT);
        else if (action === 'skip') handleOpen(SwipeDirection.LEFT);
        else onOpen(item);
      }}
    >
      <ReanimatedSwipeable
        ref={swipeable}
        testID={`swipe-${item.txn.id}`}
        friction={2}
        overshootLeft={false}
        overshootRight={false}
        onSwipeableOpen={handleOpen}
        renderLeftActions={() => (
          <View style={styles.panel('reviewed')}>
            <Icon name="check" size="md" tone="income" />
            <Text variant="label" tone="income">
              Reviewed
            </Text>
          </View>
        )}
        renderRightActions={() => (
          <View style={styles.panel('skip')}>
            <Text variant="label" tone="muted">
              Skip
            </Text>
            <Icon name="chevron-right" size="md" tone="muted" />
          </View>
        )}
      >
        <View style={styles.content}>
          <TransactionRow
            row={item}
            lookups={lookups}
            onPress={() => onOpen(item)}
            caption={<ConfidencePill item={item} />}
          />
        </View>
      </ReanimatedSwipeable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { backgroundColor: theme.colors.surface },
  panel: (kind: 'reviewed' | 'skip') => ({
    flex: 1,
    minWidth: theme.size.sidebarWidth,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: kind === 'reviewed' ? 'flex-start' : 'flex-end',
    gap: theme.space.sm,
    paddingHorizontal: theme.space.xl,
    backgroundColor: kind === 'reviewed' ? theme.colors.incomeMuted : theme.colors.surfaceSunken,
  }),
}));
