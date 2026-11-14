import type { LinkChallenge, SophtronLinkStatus } from '@manaclaude/shared';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Button } from '../../design/components/Button';
import { Card } from '../../design/components/Card';
import { Chip, TextField } from '../../design/components/Controls';
import { ListRow } from '../../design/components/ListRow';
import { HStack, VStack } from '../../design/components/Layout';
import { Text } from '../../design/components/Text';
import { BackendError, errorText, isSuperseded } from '../../data/backend/client';
import { refreshDataset } from '../../data/backend/sync';
import { linkApi } from './linkApi';
import {
  doneConnection,
  isRateLimited,
  isResultUnavailable,
  outcomeUnknown,
  pollSophtron,
  sophtronTiming,
  type PollEnd,
} from './sophtronPoll';
import type { FlowProps } from './types';

/** Why the app can't say how a sign-in ended. */
type Unconfirmed =
  /** The answer to start never arrived: a sign-in may have begun with no linkId to ask about. */
  | 'start_lost'
  /** The Worker can't confirm the result (409 link_result_unavailable, or a "done" without the connection). */
  | 'result_unavailable';

type Step =
  | { kind: 'choose' }
  | { kind: 'search' }
  | { kind: 'credentials'; institution: { id: string; name: string } }
  | { kind: 'waiting'; linkId: string; round: number; firstWaitMs?: number }
  | { kind: 'mfa'; linkId: string; challenge: LinkChallenge }
  /** Waiting stopped without an answer; the same sign-in can be checked again. */
  | { kind: 'stalled'; linkId: string; message: string }
  /** Accounts is reloaded (null while it loads) and nothing is started by itself. */
  | { kind: 'unconfirmed'; why: Unconfirmed; reloaded: boolean | null };

/**
 * Sophtron: find the bank, sign in once (the password goes to Sophtron and is
 * not stored), answer any security question or code, done. Repair first tries
 * the same login again (the bank asks its question again); signing in anew is
 * the fallback.
 *
 * The linkId from start is kept for the whole sign-in. Every later question
 * is about that linkId (sophtronPoll.ts): after a lost answer the app asks
 * again about the same sign-in and never sends start again by itself. When
 * the outcome can't be known, the app reloads Accounts and waits for you to
 * decide.
 */
export function SophtronFlow({ connectionId, onLinked }: FlowProps) {
  const first: Step = connectionId ? { kind: 'choose' } : { kind: 'search' };
  const [step, setStep] = useState<Step>(first);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bank, setBank] = useState<string | null>(null);
  // One start or answer at a time, even with two quick taps.
  const sending = useRef(false);
  const mounted = useRef(true);
  const reloads = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const unconfirmed = (why: Unconfirmed) => {
    const mine = ++reloads.current;
    setError(null);
    setNotice(null);
    setStep({ kind: 'unconfirmed', why, reloaded: null });
    void refreshDataset().then((ok) => {
      if (!mounted.current || reloads.current !== mine) return;
      setStep((s) => (s.kind === 'unconfirmed' ? { ...s, reloaded: ok } : s));
    });
  };

  const follow = (s: SophtronLinkStatus) => {
    setNotice(null);
    if (s.status === 'done') {
      const found = doneConnection(s, connectionId);
      if (found) onLinked(found.connectionIds, found.repaired);
      else unconfirmed('result_unavailable');
    } else if (s.status === 'failed') {
      setError(s.message ?? 'The bank did not accept the sign-in.');
      setStep(first);
    } else if (s.status === 'mfa' && s.challenge)
      setStep({ kind: 'mfa', linkId: s.linkId, challenge: s.challenge });
    else setStep((prev) => ({ kind: 'waiting', linkId: s.linkId, round: roundOf(prev) + 1 }));
  };

  const once = async (work: () => Promise<void>) => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
    } finally {
      sending.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  // Start has no retry key: an answer that did not arrive is never sent again.
  const start = (body: Parameters<typeof linkApi.sophtronStart>[0]) =>
    once(async () => {
      setBank(body.institutionName ?? null);
      try {
        follow(await linkApi.sophtronStart(body));
      } catch (e) {
        if (isResultUnavailable(e)) unconfirmed('result_unavailable');
        else if (outcomeUnknown(e) || isRateLimited(e)) unconfirmed('start_lost');
        else setError(errorText(e));
      }
    });

  // An answer has no retry key either. When its outcome is not known, ask
  // about the same sign-in before asking for another answer.
  const answer = (linkId: string, a: Parameters<typeof linkApi.sophtronAnswer>[1]) =>
    once(async () => {
      try {
        follow(await linkApi.sophtronAnswer(linkId, a));
      } catch (e) {
        if (isSuperseded(e)) {
          setError(errorText(e));
          setStep(first);
        } else if (isResultUnavailable(e)) unconfirmed('result_unavailable');
        else if (answerRefused(e)) setError(errorText(e));
        else {
          setNotice(
            'Your answer may or may not have reached the bank. Checking this sign-in before asking for anything again...',
          );
          setStep((prev) => ({
            kind: 'waiting',
            linkId,
            round: roundOf(prev) + 1,
            firstWaitMs: isRateLimited(e) ? sophtronTiming.rateLimitWaitMs : undefined,
          }));
        }
      }
    });

  const pollEnded = (end: PollEnd) => {
    if (end.kind === 'cancelled' || step.kind !== 'waiting') return;
    if (end.kind === 'status') follow(end.status);
    else if (end.kind === 'unavailable') unconfirmed('result_unavailable');
    else if (end.kind === 'stalled') {
      setNotice(null);
      setStep({ kind: 'stalled', linkId: step.linkId, message: end.message });
    } else {
      setNotice(null);
      setError(end.message);
      setStep(first);
    }
  };

  return (
    <VStack gap="md">
      {error ? (
        <Text variant="body" tone="danger" testID="link-error">
          {error}
        </Text>
      ) : null}
      {notice ? (
        <Text variant="body" tone="muted" testID="sophtron-notice">
          {notice}
        </Text>
      ) : null}
      {step.kind === 'choose' ? (
        <Card>
          <VStack gap="md">
            <Text variant="body">
              {
                "Most repairs only need the bank's question answered again. If you changed your bank password, sign in again instead."
              }
            </Text>
            <Button
              label="Answer the bank's question"
              loading={busy}
              onPress={() => void start({ connectionId, refresh: true })}
              testID="sophtron-refresh"
            />
            <Button
              label="Sign in again"
              variant="secondary"
              onPress={() => setStep({ kind: 'search' })}
            />
          </VStack>
        </Card>
      ) : null}
      {step.kind === 'search' ? (
        <SearchBank onPick={(institution) => setStep({ kind: 'credentials', institution })} />
      ) : null}
      {step.kind === 'credentials' ? (
        <Credentials
          institution={step.institution}
          busy={busy}
          onSubmit={(username, password, pin) =>
            void start({
              institutionId: step.institution.id,
              institutionName: step.institution.name,
              username,
              password,
              pin: pin || undefined,
              connectionId,
            })
          }
          onBack={() => setStep({ kind: 'search' })}
        />
      ) : null}
      {step.kind === 'waiting' ? (
        <Waiting
          key={step.round}
          linkId={step.linkId}
          firstWaitMs={step.firstWaitMs}
          onEnd={pollEnded}
        />
      ) : null}
      {step.kind === 'mfa' ? (
        <Challenge
          key={step.linkId + JSON.stringify(step.challenge)}
          challenge={step.challenge}
          busy={busy}
          onAnswer={(a) => void answer(step.linkId, a)}
        />
      ) : null}
      {step.kind === 'stalled' ? (
        <Card>
          <VStack gap="md">
            <Text variant="body" testID="sophtron-stalled">
              {step.message}
            </Text>
            <Button
              label="Check again"
              onPress={() => {
                setError(null);
                setStep({ kind: 'waiting', linkId: step.linkId, round: 0 });
              }}
              testID="sophtron-check-again"
            />
            <Button
              label="Start over"
              variant="ghost"
              onPress={() => {
                setError(null);
                setStep(first);
              }}
              testID="sophtron-start-over"
            />
          </VStack>
        </Card>
      ) : null}
      {step.kind === 'unconfirmed' ? (
        <Card>
          <VStack gap="md">
            <Text variant="headline">Not confirmed</Text>
            <Text variant="body" testID="sophtron-unconfirmed">
              {unconfirmedText(step.why, Boolean(connectionId))}
            </Text>
            {step.reloaded === null ? (
              <HStack gap="sm">
                <ActivityIndicator accessibilityLabel="Reloading Accounts" />
                <Text variant="body" tone="muted">
                  Reloading Accounts from your Worker...
                </Text>
              </HStack>
            ) : (
              <Text variant="body" testID="sophtron-reloaded">
                {reloadedText(step.reloaded, Boolean(connectionId), bank)}
              </Text>
            )}
            {step.reloaded === false ? (
              <Button
                label="Reload Accounts"
                onPress={() => unconfirmed(step.why)}
                testID="sophtron-reload"
              />
            ) : null}
            {step.reloaded ? (
              <Button
                label="Open Accounts"
                variant="secondary"
                onPress={() => router.push('/accounts')}
                testID="sophtron-open-accounts"
              />
            ) : null}
            {/* A new sign-in only once Accounts is up to date, and only on your own tap. */}
            {step.reloaded ? (
              <Button
                label="Start over"
                variant="ghost"
                onPress={() => {
                  setError(null);
                  setStep(first);
                }}
                testID="sophtron-start-over"
              />
            ) : null}
          </VStack>
        </Card>
      ) : null}
    </VStack>
  );
}

const roundOf = (step: Step): number => (step.kind === 'waiting' ? step.round : 0);

/** The Worker refused the answer outright (bad input, wrong token): it was not used. */
function answerRefused(e: unknown): boolean {
  return (
    e instanceof BackendError &&
    e.status >= 400 &&
    e.status < 500 &&
    e.status !== 404 &&
    e.status !== 429
  );
}

/** What the screen says when the app can't tell how a sign-in ended. */
function unconfirmedText(why: Unconfirmed, repair: boolean): string {
  if (why === 'start_lost')
    return repair
      ? "The answer from your Worker didn't arrive, so the repair may have started at the bank anyway. Nothing was sent again."
      : "The answer from your Worker didn't arrive, so a sign-in may have started at the bank anyway. Nothing was sent again.";
  return repair
    ? "Your Worker can't confirm how this repair ended, so the app has not marked anything repaired and has not started another sign-in."
    : "Your Worker can't confirm how this sign-in ended, so the app has not linked anything and has not started another sign-in.";
}

function reloadedText(reloaded: boolean, repair: boolean, bank: string | null): string {
  if (!reloaded)
    return 'Accounts could not be reloaded. Check your connection and reload before you sign in again.';
  if (repair)
    return 'Accounts has been reloaded. If this connection no longer shows a problem there, the repair went through. Start over only if it still needs repair.';
  return `Accounts has been reloaded. If ${bank ? `"${bank}"` : 'the bank'} is there, the sign-in was saved. Start over only if it is not, so the bank is not linked twice.`;
}

function SearchBank({ onPick }: { onPick: (i: { id: string; name: string }) => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ id: string; name: string; url: string | null }[] | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const search = async () => {
    if (query.trim().length < 2) return;
    setBusy(true);
    setError(null);
    try {
      setResults((await linkApi.sophtronSearch(query.trim())).institutions);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <VStack gap="md">
      <Card>
        <VStack gap="md">
          <TextField
            label="Your bank"
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={search}
            placeholder="Bank or card name"
            icon="search"
            returnKeyType="search"
            testID="sophtron-search"
          />
          <Button label="Search" onPress={search} loading={busy} testID="sophtron-search-go" />
          {error ? (
            <Text variant="caption" tone="danger">
              {error}
            </Text>
          ) : null}
        </VStack>
      </Card>
      {results ? (
        <Card padding="none">
          {results.length === 0 ? (
            <Text variant="body" tone="muted" style={styles.empty}>
              Nothing found. Try a shorter name, or link this bank with SimpleFIN.
            </Text>
          ) : (
            results.map((r) => (
              <ListRow
                key={r.id}
                title={r.name}
                subtitle={r.url ?? undefined}
                showChevron
                onPress={() => onPick(r)}
              />
            ))
          )}
        </Card>
      ) : null}
    </VStack>
  );
}

function Credentials({
  institution,
  busy,
  onSubmit,
  onBack,
}: {
  institution: { id: string; name: string };
  busy: boolean;
  onSubmit: (username: string, password: string, pin: string) => void;
  onBack: () => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  return (
    <Card>
      <VStack gap="md">
        <Text variant="headline">{institution.name}</Text>
        <Text variant="caption" tone="muted">
          {
            "Use the same sign-in as the bank's website. Your password goes to Sophtron once, to sign in. Billionaire does not keep it."
          }
        </Text>
        <TextField
          label="User name"
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
          autoCorrect={false}
          testID="sophtron-user"
        />
        <TextField
          label="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          testID="sophtron-password"
        />
        <TextField
          label="PIN (only if the bank asks for one)"
          value={pin}
          onChangeText={setPin}
          secureTextEntry
          keyboardType="number-pad"
        />
        <HStack gap="sm">
          <Button
            label="Connect"
            loading={busy}
            disabled={!username || !password}
            onPress={() => onSubmit(username, password, pin)}
            testID="sophtron-connect"
          />
          <Button label="Other bank" variant="ghost" onPress={onBack} />
        </HStack>
      </VStack>
    </Card>
  );
}

function Waiting({
  linkId,
  firstWaitMs,
  onEnd,
}: {
  linkId: string;
  firstWaitMs?: number;
  onEnd: (end: PollEnd) => void;
}) {
  // Keep the latest callback without restarting the wait on every render.
  const ended = useRef(onEnd);
  // Read once: a new wait is a new round (the component's key).
  const firstWait = useRef(firstWaitMs);
  useEffect(() => {
    ended.current = onEnd;
  });
  useEffect(() => {
    let live = true;
    void pollSophtron(linkId, () => live, { firstWaitMs: firstWait.current }).then((end) => {
      if (live) ended.current(end);
    });
    return () => {
      live = false;
    };
  }, [linkId]);
  return (
    <Card>
      <VStack gap="md" align="center">
        <ActivityIndicator accessibilityLabel="Signing in" />
        <Text variant="body" tone="muted" align="center">
          Signing in to your bank through Sophtron. This can take a minute.
        </Text>
      </VStack>
    </Card>
  );
}

function Challenge({
  challenge,
  busy,
  onAnswer,
}: {
  challenge: LinkChallenge;
  busy: boolean;
  onAnswer: (a: Parameters<typeof linkApi.sophtronAnswer>[1]) => void;
}) {
  const [answers, setAnswers] = useState<string[]>(challenge.securityQuestions.map(() => ''));
  const [code, setCode] = useState('');
  if (challenge.securityQuestions.length > 0) {
    return (
      <Card>
        <VStack gap="md">
          <Text variant="headline">Your bank asks</Text>
          {challenge.securityQuestions.map((q, i) => (
            <TextField
              key={q}
              label={q}
              value={answers[i] ?? ''}
              onChangeText={(v) => setAnswers((a) => a.map((x, j) => (j === i ? v : x)))}
              autoCapitalize="none"
              testID={`sophtron-answer-${i}`}
            />
          ))}
          <Button
            label="Send"
            loading={busy}
            disabled={answers.some((a) => !a.trim())}
            onPress={() => onAnswer({ type: 'security_answer', answers })}
            testID="sophtron-send"
          />
        </VStack>
      </Card>
    );
  }
  if (challenge.tokenMethods.length > 0) {
    return (
      <Card>
        <VStack gap="md">
          <Text variant="headline">Where should the bank send a code?</Text>
          <HStack gap="sm" wrap>
            {challenge.tokenMethods.map((m) => (
              <Chip
                key={m}
                label={m}
                onPress={() => onAnswer({ type: 'token_choice', choice: m })}
              />
            ))}
          </HStack>
        </VStack>
      </Card>
    );
  }
  if (challenge.tokenSent) {
    return (
      <Card>
        <VStack gap="md">
          <Text variant="headline">Enter the code the bank sent</Text>
          <TextField
            label="Code"
            value={code}
            onChangeText={setCode}
            keyboardType="number-pad"
            autoComplete="one-time-code"
            testID="sophtron-code"
          />
          <Button
            label="Send"
            loading={busy}
            disabled={!code.trim()}
            onPress={() => onAnswer({ type: 'token_input', code })}
          />
        </VStack>
      </Card>
    );
  }
  if (challenge.tokenRead) {
    return (
      <Card>
        <VStack gap="md">
          <Text variant="headline">Approve the sign-in</Text>
          <Text variant="body">{challenge.tokenRead}</Text>
          <Button
            label="I approved it"
            loading={busy}
            onPress={() => onAnswer({ type: 'verify_phone' })}
          />
        </VStack>
      </Card>
    );
  }
  return (
    <Card>
      <VStack gap="md">
        <Text variant="headline">Type the characters you see</Text>
        {challenge.captchaImage ? (
          <Image
            source={{ uri: `data:image/png;base64,${challenge.captchaImage}` }}
            style={styles.captcha}
            resizeMode="contain"
            accessibilityLabel="Captcha"
          />
        ) : null}
        <TextField label="Characters" value={code} onChangeText={setCode} autoCapitalize="none" />
        <Button
          label="Send"
          loading={busy}
          disabled={!code.trim()}
          onPress={() => onAnswer({ type: 'captcha', text: code })}
        />
      </VStack>
    </Card>
  );
}

const styles = StyleSheet.create((theme) => ({
  empty: { padding: theme.space.lg },
  captcha: { width: '100%', height: theme.size.avatarLg * 2 },
}));
