import { router } from 'expo-router';
import { useEffect } from 'react';
import { Card } from '../../design/components/Card';
import { IconBadge } from '../../design/components/Decor';
import { ListRow } from '../../design/components/ListRow';
import { isBackendReady, useBackendConfig } from '../../data/backend/config';
import { useBackendStatus } from '../../data/backend/status';
import { loadAlerts, useAlerts } from './alertsStore';

/**
 * The way to the Alerts screen from Home: one row with how many alerts are
 * waiting. Shown only with a backend set; it reloads whenever the app's data
 * was loaded again (pull to refresh, opening the app).
 */
export function AlertsEntry() {
  const config = useBackendConfig();
  const ready = isBackendReady(config);
  const { lastLoadedAt } = useBackendStatus();
  const { alerts, error } = useAlerts();

  useEffect(() => {
    if (ready) void loadAlerts();
  }, [ready, config.scope, lastLoadedAt]);

  if (!ready) return null;
  const n = alerts?.length ?? 0;
  return (
    <Card padding="none" onPress={() => router.navigate('/alerts')} accessibilityLabel="Alerts">
      <ListRow
        title={
          alerts === null
            ? 'Alerts'
            : n === 0
              ? 'No alerts'
              : `${n} ${n === 1 ? 'alert' : 'alerts'}`
        }
        subtitle={
          alerts === null
            ? error
              ? 'Could not be loaded. Open to try again.'
              : 'Checking...'
            : n === 0
              ? 'Nothing looks doubled, unusual or raised'
              : 'Charges that look doubled, unusual or raised'
        }
        leading={<IconBadge icon="bell" color={n > 0 ? 'c11' : 'c1'} />}
        showChevron
        testID="alerts-entry"
      />
    </Card>
  );
}
