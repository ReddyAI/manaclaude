import { router } from 'expo-router';
import { Card } from '../../design/components/Card';
import { IconBadge } from '../../design/components/Decor';
import { ListRow } from '../../design/components/ListRow';
import { isBackendReady, useBackendConfig } from '../../data/backend/config';

/** The way to Ask AI from Home. Shown only with a backend set, since the Worker answers. */
export function AskEntry() {
  const ready = isBackendReady(useBackendConfig());
  if (!ready) return null;
  return (
    <Card padding="none" onPress={() => router.navigate('/ask')} accessibilityLabel="Ask AI">
      <ListRow
        title="Ask AI"
        subtitle="A question about your money, in plain English"
        leading={<IconBadge icon="bot" color="c2" />}
        showChevron
        testID="ask-entry"
      />
    </Card>
  );
}
