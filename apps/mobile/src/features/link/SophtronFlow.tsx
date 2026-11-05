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
import type { FlowProps } from './types';

type Step =
  | { kind: 'choose' }
  | { kind: 'search' }
  | { kind: 'credentials'; institution: { id: string; name: string } }
  | { kind: 'waiting'; linkId: string }
  | { kind: 'mfa'; linkId: string; challenge: LinkChallenge };

const POLL_MS = 3000;
const POLL_LIMIT = 60;

/**
 * Sophtron: find the bank, sign in once (the password goes to Sophtron and is
 * not stored), answer any security question or code, done. Repair first tries
 * the same login again (the bank asks its question again); signing in anew is
 * the fallback.
 */
export function SophtronFlow({ connectionId, onLinked }: FlowProps) {
  const [step, setStep] = useState<Step>(connectionId ? { kind: 'choose' } : { kind: 'search' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const follow = (s: SophtronLinkStatus) => {
    if (s.status === 'done' && s.connectionIds?.length)
      onLinked(s.connectionIds, s.repaired ?? false);
    else if (s.status === 'failed') {
      setError(s.message ?? 'The bank did not accept the sign-in.');
      setStep(connectionId ? { kind: 'choose' } : { kind: 'search' });
    } else if (s.status === 'mfa' && s.challenge)
      setStep({ kind: 'mfa', linkId: s.linkId, challenge: s.challenge });
    else setStep({ kind: 'waiting', linkId: s.linkId });
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
              onPress={() => run(() => linkApi.sophtronStart({ connectionId, refresh: true }))}
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
            run(() =>
              linkApi.sophtronStart({
                institutionId: step.institution.id,
                institutionName: step.institution.name,
                username,
                password,
                pin: pin || undefined,
                connectionId,
              }),
            )
          }
          onBack={() => setStep({ kind: 'search' })}
        />
      ) : null}
      {step.kind === 'waiting' ? (
        <Waiting linkId={step.linkId} onStatus={follow} onError={setError} />
      ) : null}
      {step.kind === 'mfa' ? (
        <Challenge
          challenge={step.challenge}
          busy={busy}
          onAnswer={(answer) => run(() => linkApi.sophtronAnswer(step.linkId, answer))}
        />
      ) : null}
    </VStack>
  );
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
  onStatus,
  onError,
}: {
  linkId: string;
  onStatus: (s: SophtronLinkStatus) => void;
  onError: (message: string) => void;
}) {
  const polls = useRef(0);
  // Keep the latest callbacks without restarting the timer on every render.
  const callbacks = useRef({ onStatus, onError });
  useEffect(() => {
    callbacks.current = { onStatus, onError };
  });
  useEffect(() => {
    let live = true;
    const { onStatus: status, onError: fail } = {
      onStatus: (s: SophtronLinkStatus) => callbacks.current.onStatus(s),
      onError: (m: string) => callbacks.current.onError(m),
    };
    const timer = setInterval(() => {
      polls.current += 1;
      if (polls.current > POLL_LIMIT) {
        clearInterval(timer);
        fail('The bank is taking too long. Try again in a few minutes.');
        return;
      }
      linkApi.sophtronStatus(linkId).then(
        (s) => {
          if (!live || s.status === 'pending') return;
          clearInterval(timer);
          status(s);
        },
        (e: unknown) => {
          if (!live) return;
          clearInterval(timer);
          fail(errorText(e));
        },
      );
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
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
