import type { LinkChallenge, SophtronLinkStatus } from '@manaclaude/shared';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Button } from '../../design/components/Button';
import { Card } from '../../design/components/Card';
import { Chip, TextField } from '../../design/components/Controls';
import { ListRow } from '../../design/components/ListRow';
import { HStack, VStack } from '../../design/components/Layout';
import { Text } from '../../design/components/Text';
import { errorText } from '../../data/backend/client';
import { linkApi } from './linkApi';
import {
  findFinishedConnection,
  pollSophtron,
  sophtronConnectionsNow,
  type Found,
  type Missing,
  type PollEnd,
} from './sophtronPoll';
import type { FlowProps } from './types';

type Step =
  | { kind: 'choose' }
  | { kind: 'search' }
  | { kind: 'credentials'; institution: { id: string; name: string } }
  | { kind: 'waiting'; linkId: string; round: number }
  | { kind: 'mfa'; linkId: string; challenge: LinkChallenge }
  /** Waiting stopped without an answer; the same sign-in can be checked again. */
  | { kind: 'stalled'; linkId: string; message: string }
  /** The Worker said done without naming the connection; the app is looking for it. */
  | { kind: 'confirming'; linkId: string; round: number }
  | { kind: 'unconfirmed'; linkId: string; why: Missing };

/**
 * Sophtron: find the bank, sign in once (the password goes to Sophtron and is
 * not stored), answer any security question or code, done. Repair first tries
 * the same login again (the bank asks its question again); signing in anew is
 * the fallback.
 *
 * The app asks for the status one request at a time (sophtronPoll.ts). When
 * the Worker says the sign-in is done but does not name the connection, the
 * app reloads the data and looks for it; if it is not there, it says so and
 * changes nothing.
 */
export function SophtronFlow({ connectionId, onLinked }: FlowProps) {
  const first: Step = connectionId ? { kind: 'choose' } : { kind: 'search' };
  const [step, setStep] = useState<Step>(first);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // What was there before this sign-in, to recognise the connection it makes.
  const [attempt, setAttempt] = useState<{
    before: ReadonlySet<string> | null;
    institutionName: string | null;
  }>({ before: null, institutionName: null });

  const follow = (s: SophtronLinkStatus) => {
    if (s.status === 'done') {
      if (s.connectionIds?.length) onLinked(s.connectionIds, s.repaired ?? false);
      else setStep({ kind: 'confirming', linkId: s.linkId, round: 0 });
    } else if (s.status === 'failed') {
      setError(s.message ?? 'The bank did not accept the sign-in.');
      setStep(first);
    } else if (s.status === 'mfa' && s.challenge)
      setStep({ kind: 'mfa', linkId: s.linkId, challenge: s.challenge });
    else setStep((prev) => ({ kind: 'waiting', linkId: s.linkId, round: roundOf(prev) + 1 }));
  };

  const run = async (call: () => Promise<SophtronLinkStatus>) => {
    setBusy(true);
    setError(null);
    try {
      follow(await call());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const start = (body: Parameters<typeof linkApi.sophtronStart>[0]) => {
    setAttempt({
      before: sophtronConnectionsNow(),
      institutionName: body.institutionName ?? null,
    });
    return run(() => linkApi.sophtronStart(body));
  };

  const pollEnded = (end: PollEnd) => {
    if (end.kind === 'cancelled' || step.kind !== 'waiting') return;
    if (end.kind === 'status') follow(end.status);
    else if (end.kind === 'stalled')
      setStep({ kind: 'stalled', linkId: step.linkId, message: end.message });
    else {
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
              onPress={() => start({ connectionId, refresh: true })}
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
            start({
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
        <Waiting key={step.round} linkId={step.linkId} onEnd={pollEnded} />
      ) : null}
      {step.kind === 'mfa' ? (
        <Challenge
          challenge={step.challenge}
          busy={busy}
          onAnswer={(answer) => run(() => linkApi.sophtronAnswer(step.linkId, answer))}
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
      {step.kind === 'confirming' ? (
        <Confirming
          key={step.round}
          target={{ connectionId, ...attempt }}
          onFound={(found) => onLinked(found.connectionIds, found.repaired)}
          onMissing={(why) => setStep({ kind: 'unconfirmed', linkId: step.linkId, why })}
        />
      ) : null}
      {step.kind === 'unconfirmed' ? (
        <Card>
          <VStack gap="md">
            <Text variant="headline">Not confirmed</Text>
            <Text variant="body" testID="sophtron-unconfirmed">
              {unconfirmedText(step.why, Boolean(connectionId))}
            </Text>
            <Button
              label="Look again"
              onPress={() => setStep({ kind: 'confirming', linkId: step.linkId, round: 0 })}
              testID="sophtron-look-again"
            />
            <Button
              label="Start over"
              variant="ghost"
              onPress={() => setStep(first)}
              testID="sophtron-start-over"
            />
          </VStack>
        </Card>
      ) : null}
    </VStack>
  );
}

const roundOf = (step: Step): number =>
  step.kind === 'waiting' || step.kind === 'confirming' ? step.round : 0;

/** What the screen says when a finished sign-in cannot be matched to a connection. */
function unconfirmedText(why: Missing, repair: boolean): string {
  if (why === 'unreachable')
    return 'Sophtron says the sign-in finished, but the app could not reload your data, so it cannot tell whether it was saved. Check your connection, then look again. Do not sign in again until you have looked.';
  return repair
    ? 'Sophtron says the sign-in finished, but this connection still shows a problem on your backend, so the repair is not confirmed. The connection and its error are left as they are. Look again in a moment, or sign in again.'
    : 'Sophtron says the sign-in finished, but the app cannot find a new connection on your backend. It may not have been saved. Look again in a moment, and check Accounts before you sign in again, so the same bank is not linked twice.';
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

function Waiting({ linkId, onEnd }: { linkId: string; onEnd: (end: PollEnd) => void }) {
  // Keep the latest callback without restarting the wait on every render.
  const ended = useRef(onEnd);
  useEffect(() => {
    ended.current = onEnd;
  });
  useEffect(() => {
    let live = true;
    void pollSophtron(linkId, () => live).then((end) => {
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

type ConfirmTarget = Parameters<typeof findFinishedConnection>[0];

function Confirming({
  target,
  onFound,
  onMissing,
}: {
  target: ConfirmTarget;
  onFound: (found: Found) => void;
  onMissing: (why: Missing) => void;
}) {
  const latest = useRef({ target, onFound, onMissing });
  useEffect(() => {
    latest.current = { target, onFound, onMissing };
  });
  useEffect(() => {
    let live = true;
    void findFinishedConnection(latest.current.target, () => live).then((result) => {
      if (!live) return;
      if ('missing' in result) latest.current.onMissing(result.missing);
      else latest.current.onFound(result);
    });
    return () => {
      live = false;
    };
  }, []);
  return (
    <Card>
      <VStack gap="md" align="center">
        <ActivityIndicator accessibilityLabel="Looking for the connection" />
        <Text variant="body" tone="muted" align="center" testID="sophtron-confirming">
          Sophtron finished the sign-in. Looking for the connection on your backend...
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
