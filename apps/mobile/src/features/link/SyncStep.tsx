import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator } from 'react-native';
import { Button } from '../../design/components/Button';
import { Card } from '../../design/components/Card';
import { VStack } from '../../design/components/Layout';
import { Text } from '../../design/components/Text';
import { haptic } from '../../design/haptics';
import { errorText } from '../../data/backend/client';
import { refreshDataset } from '../../data/backend/sync';
import { syncUntilDone } from './linkApi';
import { sentence } from './types';

/**
 * After a login is saved: fetch its data. A first sync with years of history
 * comes in parts; the counter shows how far it is. Leaving the screen is fine:
 * the backend's five-minute job finishes it.
 *
 * For a repair, this sync is the proof. The screen says "Repaired" only after
 * a sync on the repaired login has worked; until then it is being checked,
 * and if the sync fails the repair is reported as not confirmed.
 */
export function SyncStep({
  connectionIds,
  repaired,
}: {
  connectionIds: string[];
  repaired: boolean;
}) {
  const [inserted, setInserted] = useState(0);
  const [state, setState] = useState<'running' | 'done' | 'problem'>('running');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      let total = 0;
      const problems: string[] = [];
      for (const id of connectionIds) {
        try {
          const report = await syncUntilDone(id, (p) => live && setInserted(total + p.inserted), {
            force: repaired,
          });
          total += report.summary?.inserted ?? 0;
          // A skipped sync proves nothing about a repaired login.
          const worked = report.outcome === 'ok' || (!repaired && report.outcome === 'skipped');
          if (!worked)
            problems.push(
              report.error ??
                (repaired ? 'The sync did not finish.' : 'The first sync did not finish.'),
            );
        } catch (e) {
          problems.push(errorText(e));
        }
      }
      await refreshDataset();
      if (!live) return;
      setState(problems.length ? 'problem' : 'done');
      setMessage(problems[0] ?? null);
      haptic(problems.length ? 'reject' : 'confirm');
    })();
    return () => {
      live = false;
    };
  }, [connectionIds, repaired]);

  return (
    <Card>
      <VStack gap="md">
        <Text variant="headline" testID="sync-headline">
          {state === 'running'
            ? repaired
              ? 'Checking the login with a sync...'
              : 'Linked. Fetching your history...'
            : state === 'done'
              ? repaired
                ? 'Repaired and synced'
                : 'All set'
              : repaired
                ? 'The repair is not confirmed'
                : 'Saved, but the sync had a problem'}
        </Text>
        {state === 'running' ? <ActivityIndicator accessibilityLabel="Syncing" /> : null}
        <Text variant="body" tone="muted" testID="sync-progress">
          {state === 'running'
            ? inserted > 0
              ? `${inserted.toLocaleString()} transactions so far. A long history comes in parts; you can leave this screen and it keeps going.`
              : 'Talking to the bank. This can take a minute.'
            : state === 'problem' && repaired
              ? `${sentence(message ?? 'The sync did not finish.')} The sync after the repair did not work, so the connection keeps its error. Try Repair again from Accounts.`
              : (message ?? `${inserted.toLocaleString()} transactions added.`)}
        </Text>
        {state !== 'running' ? (
          <Button
            label="Back to accounts"
            onPress={() => router.replace('/accounts')}
            testID="sync-done"
          />
        ) : null}
      </VStack>
    </Card>
  );
}
