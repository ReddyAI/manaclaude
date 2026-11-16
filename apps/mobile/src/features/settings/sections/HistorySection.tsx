import { useEffect } from 'react';
import { IconBadge } from '../../../design/components/Decor';
import { ListRow } from '../../../design/components/ListRow';
import { isBackendReady, useBackendConfig } from '../../../data/backend/config';
import { bankReviewsStore } from '../../history/historyApi';
import { goTo } from '../../planning/navigate';
import { SettingsGroup } from '../SettingsRow';

/** The way to History sources (Monefy before a cutoff, the bank after) and the bank reviews. */
export function HistorySection() {
  const config = useBackendConfig();
  const ready = isBackendReady(config);
  const { value: reviews } = bankReviewsStore.use();
  useEffect(() => {
    if (ready) void bankReviewsStore.load();
  }, [ready, config.scope]);
  const pending = reviews?.length ?? 0;
  return (
    <SettingsGroup title="History">
      <ListRow
        title="History sources"
        subtitle={
          ready
            ? 'Monefy before a cutoff date, the bank after it'
            : 'Needs the backend (Settings, Backend)'
        }
        leading={<IconBadge icon="clock" color="c9" />}
        onPress={() => goTo('/history')}
        showChevron
        testID="settings-history"
      />
      {pending > 0 ? (
        <ListRow
          title="Bank transactions to review"
          subtitle={`${pending} ${pending === 1 ? 'looks' : 'look'} like a Monefy entry you already have`}
          leading={<IconBadge icon="triangle-alert" color="c2" />}
          onPress={() => goTo('/history/reviews')}
          showChevron
          testID="settings-history-reviews"
        />
      ) : null}
    </SettingsGroup>
  );
}
