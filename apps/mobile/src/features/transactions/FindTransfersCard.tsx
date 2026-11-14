import { useRef, useState } from 'react';
import type { MatchRunResponse } from '@manaclaude/shared';
import { Button } from '../../design/components/Button';
import { Card } from '../../design/components/Card';
import { VStack } from '../../design/components/Layout';
import { Text } from '../../design/components/Text';
import { haptic } from '../../design/haptics';
import { errorText, isSuperseded } from '../../data/backend/client';
import { isBackendReady, useBackendConfig } from '../../data/backend/config';
import { useBackendStatus } from '../../data/backend/status';
import { canSaveToBackend } from '../../data/backend/sync';
import { runTransferMatching } from './actions';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What one run of the matcher did, in plain words. */
export function matchRunText(r: MatchRunResponse): string {
  if (r.linked === 0 && r.suggested === 0) return 'No new transfers found.';
  const parts: string[] = [];
  if (r.linked > 0)
    parts.push(
      `Linked ${plural(r.linked, 'transfer', 'transfers')}; they are out of spending and income now.`,
    );
  if (r.suggested > 0)
    parts.push(`${plural(r.suggested, 'possible pair needs', 'possible pairs need')} you to pick.`);
  return parts.join(' ');
}

/**
 * "Look for transfers now": the Worker matches transfers after every sync
 * and import; this runs the same matcher on demand, for example after
 * editing an amount or a date by hand.
 */
export function FindTransfersCard() {
  const ready = isBackendReady(useBackendConfig());
  useBackendStatus();
  const live = ready && canSaveToBackend();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; failed: boolean } | null>(null);
  const running = useRef(false);

  const run = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setNote(null);
    try {
      const result = await runTransferMatching();
      haptic('confirm');
      setNote({ text: matchRunText(result), failed: false });
    } catch (e) {
      if (isSuperseded(e)) return;
      haptic('reject');
      setNote({ text: errorText(e), failed: true });
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  return (
    <Card>
      <VStack gap="sm">
        <Text variant="caption" tone="muted">
          Transfers are matched after every sync and import. Look again after changing an amount or
          a date by hand.
        </Text>
        {live ? (
          <Button
            label="Look for transfers now"
            icon="link"
            size="sm"
            variant="secondary"
            loading={busy}
            onPress={() => void run()}
            testID="find-transfers"
          />
        ) : (
          <Text variant="caption" tone="faint" testID="find-transfers-offline">
            {ready
              ? 'Your data from the Worker has not loaded yet. Pull down on Transactions to load it.'
              : 'This needs your Worker. Enter its address and your API token in Settings, Backend.'}
          </Text>
        )}
        {note ? (
          <Text
            variant="caption"
            tone={note.failed ? 'danger' : 'muted'}
            testID="find-transfers-result"
          >
            {note.text}
          </Text>
        ) : null}
      </VStack>
    </Card>
  );
}
