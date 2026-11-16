import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { formatMonth } from '@manaclaude/shared';
import { StyleSheet } from 'react-native-unistyles';
import { Button } from '../../design/components/Button';
import { Card } from '../../design/components/Card';
import { TextField } from '../../design/components/Controls';
import { Banner, EmptyState, SectionHeader } from '../../design/components/Decor';
import { HStack, VStack } from '../../design/components/Layout';
import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import { isBackendReady, useBackendConfig } from '../../data/backend/config';
import { useFinance } from '../../data/store';
import { BackAction } from '../planning/BackAction';
import { goTo } from '../planning/navigate';
import { AccountSourceCard } from './AccountSourceCard';
import { bankReviewsStore, historyStore } from './historyApi';
import {
  isGoverned,
  monthCounts,
  NOT_COMPLETE,
  REPLACES_ALL,
  withEmptyMonths,
  withYear,
} from './historyModel';
import { PolicyCheckCard } from './PolicyCheckCard';
import { usePolicyEditor } from './usePolicyEditor';

const MONTHS_SHOWN = 12;

/**
 * History sources: before a cutoff, Monefy is the history of connected bank
 * and card accounts; from the cutoff on, the bank. Whole months before the
 * cutoff can go to the bank instead. The Worker checks every change against
 * what is already saved, and nothing is saved until you press Save.
 */
export function HistorySourcesScreen() {
  const ready = isBackendReady(useBackendConfig());
  const data = useFinance();
  const store = historyStore.use();
  const reviews = bankReviewsStore.use();
  const governed = useMemo(() => data.accounts.filter(isGoverned), [data.accounts]);
  const governedIds = useMemo(() => governed.map((a) => a.id), [governed]);
  const names = useMemo(() => Object.fromEntries(governed.map((a) => [a.id, a.name])), [governed]);
  const editor = usePolicyEditor(governedIds, names);
  const [shownMonths, setShownMonths] = useState(MONTHS_SHOWN);
  const coverage = useMemo(
    () => withEmptyMonths(monthCounts(data.transactions, null)),
    [data.transactions],
  );

  useEffect(() => {
    if (ready) void bankReviewsStore.load();
  }, [ready]);

  const periodsFrom = editor.preview?.accounts ?? store.value?.accounts ?? [];
  const pending = reviews.value?.length ?? 0;
  const version = store.value?.version ?? null;

  return (
    <Screen
      title="History sources"
      subtitle="Monefy before a cutoff, the bank after"
      actions={<BackAction fallback="/settings" />}
      testID="screen-history"
    >
      {!ready ? (
        <Card>
          <EmptyState
            icon="clock"
            title="Needs your Worker"
            message="History sources are kept by your Worker. Enter its address and token in Settings, Backend."
            testID="history-no-backend"
          />
        </Card>
      ) : store.value === null ? (
        <Card>
          {store.error ? (
            <VStack gap="sm">
              <Text variant="body" testID="history-load-error">
                {`The settings could not be loaded. ${store.error}`}
              </Text>
              <HStack>
                <Button
                  label="Try again"
                  size="sm"
                  variant="secondary"
                  onPress={() => void historyStore.load()}
                  testID="history-retry-load"
                />
              </HStack>
            </VStack>
          ) : (
            <Text variant="body" tone="muted" testID="history-loading">
              Loading from your Worker...
            </Text>
          )}
        </Card>
      ) : (
        <>
          {pending > 0 ? (
            <Banner tone="pending" icon="triangle-alert">
              <VStack gap="xs">
                <Text variant="bodyStrong" testID="history-reviews-banner">
                  {`${pending} bank ${pending === 1 ? 'transaction waits' : 'transactions wait'} for your review`}
                </Text>
                <Text variant="caption" tone="muted">
                  Each one looks like a Monefy entry you already have. It is not saved until you
                  decide.
                </Text>
                <HStack>
                  <Button
                    label="Review them"
                    size="sm"
                    onPress={() => goTo('/history/reviews')}
                    testID="history-reviews-open"
                  />
                </HStack>
              </VStack>
            </Banner>
          ) : null}

          <Card>
            <VStack gap="sm">
              <Text variant="body" tone="muted">
                {`Before the cutoff, your Monefy entries are the history of your connected bank and card accounts. From the cutoff on, only the bank's transactions are saved for them, so the two never overlap. Cash, investment and accounts with no connection keep every source.`}
              </Text>
              <TextField
                label="First day the bank owns (YYYY-MM-DD)"
                value={editor.draft.defaultCutoff}
                onChangeText={editor.setCutoff}
                autoCapitalize="none"
                placeholder="2025-06-01"
                testID="history-cutoff"
              />
              <Text variant="caption" tone="muted" testID="history-version">
                {version === 0
                  ? 'No cutoff is saved yet, so bank syncs keep every transaction they get. Setting one before your first bank sync is best: accounts connected later follow it.'
                  : store.value.policy.defaultCutoff
                    ? `Saved: the bank owns from ${withYear(store.value.policy.defaultCutoff)}.`
                    : 'Saved.'}
              </Text>
            </VStack>
          </Card>

          <View>
            <SectionHeader title="Connected bank and card accounts" />
            <VStack gap="sm">
              {governed.length === 0 ? (
                <Card>
                  <Text variant="body" tone="muted" testID="history-no-accounts">
                    No connected bank or card account yet. You can save the cutoff now; accounts you
                    connect later follow it.
                  </Text>
                </Card>
              ) : (
                governed.map((a) => (
                  <AccountSourceCard
                    key={a.id}
                    account={a}
                    draft={editor.draft.accounts[a.id]}
                    defaultCutoff={editor.draft.defaultCutoff}
                    transactions={data.transactions}
                    history={periodsFrom.find((h) => h.accountId === a.id)}
                    onChange={(patch) => editor.setAccount(a.id, patch)}
                  />
                ))
              )}
              <Text variant="caption" tone="muted">
                {REPLACES_ALL}
              </Text>
              <Text variant="caption" tone="muted">
                {NOT_COMPLETE}
              </Text>
            </VStack>
          </View>

          <View>
            <SectionHeader title="Every account, by month" />
            <Card padding="none">
              {coverage.length === 0 ? (
                <View style={styles.row}>
                  <Text variant="body" tone="muted" testID="history-coverage-empty">
                    No transactions yet.
                  </Text>
                </View>
              ) : (
                coverage.slice(0, shownMonths).map((c) => (
                  <View key={c.month} style={styles.row} testID={`history-coverage-${c.month}`}>
                    <HStack justify="space-between" gap="sm">
                      <Text variant="body">{formatMonth(c.month)}</Text>
                      <Text variant="caption" tone={c.monefy + c.bank === 0 ? 'pending' : 'muted'}>
                        {`${c.monefy} Monefy · ${c.bank} bank · ${c.other} other`}
                      </Text>
                    </HStack>
                  </View>
                ))
              )}
            </Card>
            {coverage.length > shownMonths ? (
              <HStack>
                <Button
                  label="Show older months"
                  size="sm"
                  variant="ghost"
                  onPress={() => setShownMonths((n) => n + MONTHS_SHOWN)}
                  testID="history-coverage-more"
                />
              </HStack>
            ) : null}
            <Text variant="caption" tone="muted">
              {`Months with few Monefy entries are where the bank may fill the gap. "Other" is cash entries, statement files and anything typed in by hand.`}
            </Text>
          </View>

          {editor.problems.length > 0 ? (
            <Card>
              <VStack gap="xs">
                {editor.problems.map((p) => (
                  <Text key={p} variant="body" tone="pending" testID="history-problem">
                    {p}
                  </Text>
                ))}
              </VStack>
            </Card>
          ) : null}

          {editor.unsure ? (
            <Banner tone="pending" icon="triangle-alert">
              <VStack gap="xs">
                <Text variant="body" testID="history-unsure">
                  {`Your Worker didn't answer, so the app doesn't know whether the settings were saved. Try again sends exactly the same thing; if the first one was saved, the Worker says so and nothing changes twice.`}
                </Text>
                <HStack gap="sm">
                  <Button
                    label="Try again"
                    size="sm"
                    loading={editor.busy === 'save'}
                    onPress={() => void editor.retry()}
                    testID="history-retry-save"
                  />
                  <Button
                    label="Read what is saved"
                    size="sm"
                    variant="ghost"
                    onPress={editor.forget}
                    testID="history-forget-save"
                  />
                </HStack>
              </VStack>
            </Banner>
          ) : null}

          {editor.result?.kind === 'saved' ? (
            <Banner tone="accent" icon="check">
              <Text variant="body" testID="history-saved">
                {editor.result.replayed
                  ? 'These settings had already been saved by your first try. Nothing changed twice.'
                  : 'Saved. Imports and bank syncs follow these settings from now on.'}
              </Text>
            </Banner>
          ) : editor.result?.kind === 'changed' ? (
            <Banner tone="pending" icon="info">
              <Text variant="body" testID="history-changed">
                Something changed on your Worker since the check (a sync, an import or another
                device), so nothing was saved. Check the settings again before saving.
              </Text>
            </Banner>
          ) : editor.result?.kind === 'error' ? (
            <Banner tone="pending" icon="triangle-alert">
              <Text variant="body" testID="history-error">
                {editor.result.text}
              </Text>
            </Banner>
          ) : null}

          {editor.preview ? (
            <PolicyCheckCard
              preview={editor.preview}
              accounts={data.accounts}
              transactions={data.transactions}
              busy={editor.busy === 'save'}
              onSave={() => void editor.save()}
            />
          ) : null}

          <View style={styles.last}>
            <Button
              label={editor.preview ? 'Check again' : 'Check these settings'}
              variant={editor.preview?.allowed ? 'secondary' : 'primary'}
              loading={editor.busy === 'check'}
              disabled={editor.unsure !== null}
              onPress={() => void editor.check()}
              testID="history-check-button"
            />
            <Text variant="caption" tone="muted">
              Your Worker checks the settings against what is already saved. Nothing is saved,
              hidden or deleted until you press Save.
            </Text>
          </View>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.sm,
    borderBottomWidth: theme.size.hairline,
    borderColor: theme.colors.border,
  },
  last: { gap: theme.space.xs, paddingBottom: theme.space.lg },
}));
