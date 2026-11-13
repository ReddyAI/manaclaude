import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Button, IconButton } from '../../design/components/Button';
import { Card } from '../../design/components/Card';
import { Chip, TextField } from '../../design/components/Controls';
import { Banner, EmptyState } from '../../design/components/Decor';
import { HStack, VStack } from '../../design/components/Layout';
import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import { isSuperseded } from '../../data/backend/client';
import { isBackendReady, useBackendConfig } from '../../data/backend/config';
import { BackAction } from '../planning/BackAction';
import { askFailure, questionProblem, QUESTION_MAX, statusLines, type AskFailure } from './ask';
import { aiStatusStore } from './aiStatus';
import { askQuestion } from './askApi';

const EXAMPLES = [
  'How much did I spend on restaurants last month?',
  'Which category grew the most since summer?',
  'What were my total expenses in October?',
];

interface Exchange {
  id: number;
  question: string;
  answer: string;
}

/**
 * Ask a question about your money in plain English (POST /v1/ai/ask) and
 * read the answer, with what the Worker's AI is set to and today's use
 * (GET /v1/ai/status).
 *
 * Questions and answers live only in this screen's state: nothing is written
 * to the device, and all of it is gone when the screen closes or the backend
 * changes.
 */
export function AskScreen() {
  const config = useBackendConfig();
  const ready = isBackendReady(config);
  const { value: status, error: statusError } = aiStatusStore.use();
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState<string | null>(null);
  const [failure, setFailure] = useState<AskFailure | null>(null);
  const [answers, setAnswers] = useState<Exchange[]>([]);
  const [tried, setTried] = useState(false);
  const seq = useRef(0);
  // Set at once on a tap, so a fast second tap cannot send the question twice.
  const sending = useRef(false);

  // Another backend: nothing asked of the old one stays on screen.
  const [shownScope, setShownScope] = useState(config.scope);
  if (shownScope !== config.scope) {
    setShownScope(config.scope);
    setAsking(null);
    setFailure(null);
    setAnswers([]);
  }

  useEffect(() => {
    if (ready) void aiStatusStore.load();
  }, [ready, config.scope]);

  if (!ready) {
    return (
      <Screen title="Ask AI" actions={<BackAction fallback="/" />} testID="screen-ask">
        <Card>
          <EmptyState
            icon="cloud-off"
            title="Set up the backend first"
            message="Questions are answered by your Worker's AI. Enter its address and your API token in Settings, Backend."
          />
        </Card>
      </Screen>
    );
  }

  const problem = questionProblem(question);
  const off = status?.enabled === false;

  const ask = async () => {
    setTried(true);
    if (problem || sending.current || off) return;
    sending.current = true;
    const q = question.trim();
    setAsking(q);
    setFailure(null);
    try {
      const answer = await askQuestion(q);
      seq.current += 1;
      setAnswers((list) => [{ id: seq.current, question: q, answer }, ...list]);
      setQuestion('');
      setTried(false);
      setAsking(null);
    } catch (e) {
      // Asked of a backend that is no longer selected: the screen was already reset for the new one.
      if (!isSuperseded(e)) {
        setFailure(askFailure(e));
        setAsking(null);
      }
    } finally {
      sending.current = false;
    }
    // The call counts toward today's use, and a refusal may mean the settings changed.
    void aiStatusStore.load();
  };

  const summary = status ? statusLines(status) : null;

  return (
    <Screen
      title="Ask AI"
      actions={
        <HStack gap="xs">
          <IconButton
            icon="refresh-cw"
            accessibilityLabel="Reload the AI status"
            onPress={() => void aiStatusStore.load()}
            testID="ask-reload"
          />
          <BackAction fallback="/" />
        </HStack>
      }
      testID="screen-ask"
    >
      <Card>
        <VStack gap="xs">
          {summary ? (
            <>
              <Text variant="bodyStrong" testID="ask-status">
                {summary.headline}
              </Text>
              {summary.lines.map((line) => (
                <Text key={line} variant="caption" tone="muted">
                  {line}
                </Text>
              ))}
            </>
          ) : statusError ? (
            <Text variant="caption" tone="danger" testID="ask-status-error">
              {`The AI status could not be loaded. ${statusError}`}
            </Text>
          ) : (
            <Text variant="caption" tone="muted">
              Loading the AI status...
            </Text>
          )}
          {off ? (
            <Button
              label="Open Settings"
              size="sm"
              variant="secondary"
              onPress={() => router.navigate('/settings')}
              testID="ask-open-settings"
            />
          ) : null}
        </VStack>
      </Card>

      <Card>
        <VStack gap="sm">
          <TextField
            label="Your question"
            value={question}
            onChangeText={setQuestion}
            placeholder="How much did I spend on groceries in October?"
            multiline
            maxLength={QUESTION_MAX + 50}
            autoComplete="off"
            editable={!asking}
            error={tried && problem ? problem : undefined}
            testID="ask-question"
          />
          {!question ? (
            <HStack gap="xs" wrap>
              {EXAMPLES.map((e, i) => (
                <Chip
                  key={e}
                  label={e}
                  onPress={() => setQuestion(e)}
                  testID={`ask-example-${i}`}
                />
              ))}
            </HStack>
          ) : (
            <Text
              variant="caption"
              tone="faint"
            >{`${question.trim().length} of ${QUESTION_MAX}`}</Text>
          )}
          <Button
            label="Ask"
            loading={asking !== null}
            disabled={off}
            onPress={() => void ask()}
            testID="ask-send"
          />
          <Text variant="caption" tone="muted">
            To answer, the Worker sends the AI your account names and balances and six months of
            totals by category. Single transactions are not sent. Questions and answers are not
            kept: they are gone when you leave this screen.
          </Text>
        </VStack>
      </Card>

      {asking ? (
        <Text variant="caption" tone="muted" testID="ask-waiting">
          {`Asking: "${asking}"...`}
        </Text>
      ) : null}
      {failure ? (
        <Banner tone={failure.kind === 'disabled' ? 'pending' : 'danger'} icon="triangle-alert">
          <Text variant="caption" testID={`ask-failure-${failure.kind}`}>
            {failure.text}
          </Text>
        </Banner>
      ) : null}

      {answers.length > 0 ? (
        <VStack gap="sm" testID="ask-answers">
          {answers.map((a) => (
            <Card key={a.id}>
              <View style={styles.exchange}>
                <Text variant="bodyStrong">{a.question}</Text>
                <Text variant="body" selectable testID={`ask-answer-${a.id}`}>
                  {a.answer}
                </Text>
                <Text variant="caption" tone="faint">
                  Written by the AI from your totals. Check figures that matter in the app.
                </Text>
              </View>
            </Card>
          ))}
          <Button
            label="Clear"
            size="sm"
            variant="ghost"
            onPress={() => setAnswers([])}
            testID="ask-clear"
          />
        </VStack>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create((theme) => ({
  exchange: { gap: theme.space.sm },
}));
