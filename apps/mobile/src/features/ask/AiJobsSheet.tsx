import { useRef, useState } from 'react';
import { BottomSheet } from '../../design/components/BottomSheet';
import { Button } from '../../design/components/Button';
import { HStack, VStack } from '../../design/components/Layout';
import { Text } from '../../design/components/Text';
import { haptic } from '../../design/haptics';
import { errorText, isSuperseded } from '../../data/backend/client';
import { isBackendReady, useBackendConfig } from '../../data/backend/config';
import { refreshDataset } from '../../data/backend/sync';
import { useSettings } from '../../data/settingsStore';
import { loadAlerts } from '../alerts/alertsStore';
import { aiStatusStore } from './aiStatus';
import { AI_JOBS, aiJobText, runAiJob, type AiJobName } from './aiJobs';

/**
 * The Worker's AI jobs, run now instead of waiting for the nightly run
 * (POST /v1/ai/jobs/:job). One job at a time. With AI off the Worker still
 * runs them with rules and plain numbers.
 */
export function AiJobsSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const config = useBackendConfig();
  const ready = isBackendReady(config);
  const { aiEnabled } = useSettings();
  const [running, setRunning] = useState<AiJobName | null>(null);
  const [results, setResults] = useState<
    Partial<Record<AiJobName, { text: string; failed: boolean }>>
  >({});
  const busy = useRef(false);

  // Another backend: results from the old one are not shown.
  const [shownScope, setShownScope] = useState(config.scope);
  if (shownScope !== config.scope) {
    setShownScope(config.scope);
    setResults({});
  }

  const run = async (job: AiJobName) => {
    if (busy.current) return;
    busy.current = true;
    setRunning(job);
    try {
      const r = await runAiJob(job);
      haptic('confirm');
      setResults((prev) => ({ ...prev, [job]: { text: aiJobText(r), failed: false } }));
      // Categories, names, bills and recaps live in the dataset; alerts have their own list.
      await refreshDataset();
      if (job === 'alerts') void loadAlerts();
      void aiStatusStore.load();
    } catch (e) {
      if (isSuperseded(e)) return;
      haptic('reject');
      setResults((prev) => ({ ...prev, [job]: { text: errorText(e), failed: true } }));
    } finally {
      busy.current = false;
      setRunning(null);
    }
  };

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title="Run AI jobs now"
      scrollable
      testID="ai-jobs-sheet"
    >
      {!ready ? (
        <Text variant="body" tone="muted" testID="ai-jobs-no-backend">
          These run on your Worker. Enter its address and your API token in Settings, Backend.
        </Text>
      ) : (
        <VStack gap="md">
          <Text variant="caption" tone="muted">
            {aiEnabled
              ? "Your Worker runs these every night. Run one now to see its result straight away. Each AI call counts toward today's allowance."
              : 'AI is off, so these run with rules and plain numbers only. Nothing is sent to any AI.'}
          </Text>
          {AI_JOBS.map(({ job, label }) => {
            const result = results[job];
            return (
              <VStack key={job} gap="xs" testID={`ai-job-${job}`}>
                <HStack gap="sm" align="center" justify="space-between">
                  <VStack flex={1}>
                    <Text variant="body">{label}</Text>
                  </VStack>
                  <Button
                    label="Run"
                    size="sm"
                    variant="secondary"
                    loading={running === job}
                    disabled={running !== null && running !== job}
                    onPress={() => void run(job)}
                    testID={`ai-job-run-${job}`}
                  />
                </HStack>
                {result ? (
                  <Text
                    variant="caption"
                    tone={result.failed ? 'danger' : 'muted'}
                    testID={`ai-job-result-${job}`}
                  >
                    {result.text}
                  </Text>
                ) : null}
              </VStack>
            );
          })}
        </VStack>
      )}
    </BottomSheet>
  );
}
