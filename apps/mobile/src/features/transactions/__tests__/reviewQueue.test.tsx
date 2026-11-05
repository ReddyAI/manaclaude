import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { buildLookups } from '../../../data/selectors';
import { getFinance } from '../../../data/store';
import { haptic } from '../../../design/haptics';
import { setReviewed } from '../actions';
import { buildReviewQueue, confidenceLabel, reviewConfidence, reviewCount } from '../reviewQueue';
import { ReviewQueueList } from '../ReviewQueue';
import { clearSkips, skipReview } from '../reviewSkips';
import { resetFinance } from './helpers';

import '@shopify/flash-list/jestSetup';

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), canGoBack: () => true },
}));
jest.mock('../../../design/haptics', () => ({
  ...jest.requireActual('../../../design/haptics'),
  haptic: jest.fn(),
}));

// The real swipeable needs Reanimated's native runtime. This stand-in renders
// the row and exposes the handlers, so a test can "swipe" by calling them.
jest.mock('react-native-gesture-handler/ReanimatedSwipeable', () => {
  const { View } = require('react-native');
  const SwipeDirection = { LEFT: 'left', RIGHT: 'right' };
  const Swipeable = ({ children, testID, onSwipeableOpen }: Record<string, unknown>) => (
    <View testID={testID as string} onSwipeableOpen={onSwipeableOpen}>
      {children as never}
    </View>
  );
  return { __esModule: true, default: Swipeable, SwipeDirection };
});

function queue() {
  const data = getFinance();
  return buildReviewQueue(data.transactions, buildLookups(data));
}

describe('review queue order', () => {
  beforeEach(() => {
    resetFinance();
    clearSkips();
  });

  it('lists the least confident transactions first', () => {
    const items = queue();
    expect(items.length).toBeGreaterThan(3);
    const confidences = items.map((i) => i.confidence);
    expect(confidences).toEqual([...confidences].sort((a, b) => a - b));
  });

  it('puts a transaction with no category before every AI guess', () => {
    const items = queue();
    expect(items[0]?.txn.categoryId).toBeNull();
    expect(items[0]?.confidence).toBe(0);
    // The 34% Venmo guess comes before the 41% Amazon guess.
    const venmo = items.findIndex((i) => i.txn.rawName.startsWith('VENMO'));
    const amazon = items.findIndex((i) => i.confidence === 0.41);
    expect(venmo).toBeGreaterThan(-1);
    expect(amazon).toBeGreaterThan(venmo);
  });

  it('leaves out reviewed transactions, split lines and the second side of a linked transfer', () => {
    const data = getFinance();
    const lookups = buildLookups(data);
    const ids = new Set(queue().map((i) => i.txn.id));
    for (const t of data.transactions) {
      if (t.reviewed || t.splitParentId || t.isSplitParent) expect(ids.has(t.id)).toBe(false);
    }
    for (const link of data.transferLinks) {
      expect(ids.has(link.inTransactionId)).toBe(false);
    }
    expect(reviewCount(data.transactions, lookups)).toBe(ids.size);
  });

  it('treats rule and user categories as certain, and a linked transfer as its match score', () => {
    const data = getFinance();
    const lookups = buildLookups(data);
    const ruled = data.transactions.find((t) => t.categorySource === 'rule' && !t.transferLinkId);
    if (!ruled) throw new Error('sample has no rule-categorised transaction');
    expect(reviewConfidence(ruled, lookups)).toBe(1);
    const link = data.transferLinks[0];
    const out = data.transactions.find((t) => t.id === link?.outTransactionId);
    if (!out || !link) throw new Error('sample has no linked transfer');
    expect(reviewConfidence(out, lookups)).toBe(link.matchScore ?? 1);
  });

  it('moves skipped transactions to the end without reviewing them', async () => {
    const first = queue()[0];
    const second = queue()[1];
    if (!first || !second) throw new Error('queue too short');
    await act(() => skipReview(first.txn.id));
    const after = buildReviewQueue(getFinance().transactions, buildLookups(getFinance()), [
      first.txn.id,
    ]);
    expect(after[0]?.txn.id).toBe(second.txn.id);
    expect(after.at(-1)?.txn.id).toBe(first.txn.id);
    expect(after.at(-1)?.skipped).toBe(true);
    expect(getFinance().transactions.find((t) => t.id === first.txn.id)?.reviewed).toBe(false);
  });

  it('labels the confidence', () => {
    const items = queue();
    expect(confidenceLabel(items[0]!)).toBe('No category');
    const guess = items.find((i) => i.txn.aiCategoryConfidence === 0.34);
    expect(confidenceLabel(guess!)).toBe('AI 34%');
  });
});

describe('review queue swipes', () => {
  beforeEach(() => {
    resetFinance();
    clearSkips();
    (haptic as jest.Mock).mockClear();
  });

  it('swipe right marks the transaction reviewed with the confirm haptic', async () => {
    await render(<ReviewQueueList />);
    const top = queue()[0]!;
    const row = await screen.findByTestId(`swipe-${top.txn.id}`);
    await act(async () => row.props.onSwipeableOpen('right'));
    expect(getFinance().transactions.find((t) => t.id === top.txn.id)?.reviewed).toBe(true);
    expect(haptic).toHaveBeenCalledWith('confirm');
    expect(screen.queryByTestId(`swipe-${top.txn.id}`)).toBeNull();
  });

  it('swipe left skips: still unreviewed, moved to the end, no confirm haptic', async () => {
    await render(<ReviewQueueList />);
    const top = queue()[0]!;
    const row = await screen.findByTestId(`swipe-${top.txn.id}`);
    await act(async () => row.props.onSwipeableOpen('left'));
    const moved = buildReviewQueue(getFinance().transactions, buildLookups(getFinance()), [
      top.txn.id,
    ]);
    expect(moved.at(-1)?.txn.id).toBe(top.txn.id);
    expect(getFinance().transactions.find((t) => t.id === top.txn.id)?.reviewed).toBe(false);
    expect(haptic).not.toHaveBeenCalledWith('confirm');
  });

  it('shows All caught up once everything is reviewed', async () => {
    await act(async () => {
      for (const item of queue()) setReviewed(item.txn.id, true);
    });
    await render(<ReviewQueueList />);
    expect(screen.getByText('All caught up')).toBeTruthy();
  });

  it('opens the detail sheet when a row is tapped', async () => {
    await render(<ReviewQueueList />);
    const top = queue()[0]!;
    await fireEvent.press(await screen.findByTestId(`txn-${top.txn.id}`));
    expect(screen.getByTestId('transaction-detail')).toBeTruthy();
  });
});
