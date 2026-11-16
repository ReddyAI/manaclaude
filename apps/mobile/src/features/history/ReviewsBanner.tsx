import { useEffect } from 'react';
import { Button } from '../../design/components/Button';
import { Banner } from '../../design/components/Decor';
import { HStack, VStack } from '../../design/components/Layout';
import { Text } from '../../design/components/Text';
import { isBackendReady, useBackendConfig } from '../../data/backend/config';
import { goTo } from '../planning/navigate';
import { bankReviewsStore } from './historyApi';

/**
 * Bank transactions held for review, wherever a sync found them (also the
 * Worker's own scheduled syncs). Shows nothing when there are none.
 */
export function ReviewsBanner() {
  const config = useBackendConfig();
  const ready = isBackendReady(config);
  const { value } = bankReviewsStore.use();
  useEffect(() => {
    if (ready) void bankReviewsStore.load();
  }, [ready, config.scope]);
  const n = value?.length ?? 0;
  if (!ready || n === 0) return null;
  return (
    <Banner tone="pending" icon="triangle-alert">
      <VStack gap="xs">
        <Text variant="bodyStrong" testID="reviews-banner">
          {`${n} bank ${n === 1 ? 'transaction waits' : 'transactions wait'} for your review`}
        </Text>
        <Text variant="caption" tone="muted">
          {n === 1
            ? 'It looks like a Monefy entry you already have and is not saved until you decide.'
            : 'They look like Monefy entries you already have and are not saved until you decide.'}
        </Text>
        <HStack>
          <Button
            label="Review"
            size="sm"
            onPress={() => goTo('/history/reviews')}
            testID="reviews-banner-open"
          />
        </HStack>
      </VStack>
    </Banner>
  );
}
