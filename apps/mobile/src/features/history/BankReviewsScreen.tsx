import { View } from 'react-native';
import type { BankHistoryReview, Transaction } from '@manaclaude/shared';
import { StyleSheet } from 'react-native-unistyles';
import { Button } from '../../design/components/Button';
import { Card } from '../../design/components/Card';
import { Banner, EmptyState, SectionHeader } from '../../design/components/Decor';
import { HStack, VStack } from '../../design/components/Layout';
import { MoneyText } from '../../design/components/MoneyText';
import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import { useFinance } from '../../data/store';
import { BackAction } from '../planning/BackAction';
import { withYear } from './historyModel';
import { useBankReviews } from './useBankReviews';

function TxnLine({
  txn,
  accountName,
  testID,
}: {
  txn: Transaction;
  accountName: string | undefined;
  testID?: string;
}) {
  const notes = txn.notes?.split('\n')[0]?.trim();
  return (
    <HStack justify="space-between" align="flex-start" gap="sm" testID={testID}>
      <VStack gap="xxs" flex={1}>
        <Text variant="body">{txn.name || txn.rawName}</Text>
        <Text variant="caption" tone="muted">
          {[withYear(txn.date), accountName].filter(Boolean).join(' · ')}
        </Text>
        {notes ? (
          <Text variant="caption" tone="muted" numberOfLines={2}>
            {notes}
          </Text>
        ) : null}
      </VStack>
      <MoneyText amount={txn.amount} currency={txn.currency} size="small" colorize="flow" />
    </HStack>
  );
}

/**
 * Bank transactions held back because each looks like a Monefy entry that
 * is already saved (same account, currency and amount within three days).
 * Keep both, or skip the bank one. Nothing is merged either way.
 */
export function BankReviewsScreen() {
  const data = useFinance();
  const reviews = useBankReviews();
  const accountName = (id: string) => data.accounts.find((a) => a.id === id)?.name;
  const list = reviews.store.value ?? [];
  const pendingIds = new Set(list.map((r) => r.id));
  const done = Object.values(reviews.decided).filter((r) => !pendingIds.has(r.id));

  const card = (r: BankHistoryReview) => {
    const correction = r.existingTransaction !== null;
    const unsure = reviews.unsure[r.id];
    const note = reviews.notes[r.id];
    const busy = reviews.busyId === r.id;
    return (
      <Card key={r.id}>
        <VStack gap="sm" testID={`review-${r.id}`}>
          <Text variant="label" tone="muted">
            {correction ? 'The bank changed a saved transaction' : 'New from the bank'}
          </Text>
          <TxnLine
            txn={r.transaction}
            accountName={accountName(r.transaction.accountId)}
            testID={`review-bank-${r.id}`}
          />
          {r.existingTransaction ? (
            <VStack gap="xxs">
              <Text variant="caption" tone="muted">
                Saved now as:
              </Text>
              <TxnLine
                txn={r.existingTransaction}
                accountName={accountName(r.existingTransaction.accountId)}
                testID={`review-existing-${r.id}`}
              />
            </VStack>
          ) : null}
          <Text variant="caption" tone="muted">
            {r.candidates.length === 0
              ? 'The Monefy entry it looked like is gone now.'
              : r.candidates.length === 1
                ? 'It looks like this Monefy entry:'
                : `It looks like these ${r.candidates.length} Monefy entries:`}
          </Text>
          {r.candidates.map((c) => (
            <TxnLine
              key={c.id}
              txn={c}
              accountName={accountName(c.accountId)}
              testID={`review-candidate-${r.id}-${c.id}`}
            />
          ))}
          {!r.eligible ? (
            <Text variant="caption" tone="pending" testID={`review-not-eligible-${r.id}`}>
              {`The current history settings don't allow keeping it. You can skip it.`}
            </Text>
          ) : null}
          {note ? (
            <Text
              variant="caption"
              tone={note.tone === 'problem' ? 'pending' : 'muted'}
              testID={`review-note-${r.id}`}
            >
              {note.text}
            </Text>
          ) : null}
          {unsure ? (
            <HStack>
              <Button
                label="Try again"
                size="sm"
                loading={busy}
                onPress={() => void reviews.retry(r)}
                testID={`review-retry-${r.id}`}
              />
            </HStack>
          ) : (
            <HStack gap="sm" wrap>
              <Button
                label="Keep both"
                size="sm"
                variant="secondary"
                disabled={!r.eligible || reviews.busyId !== null}
                loading={busy}
                onPress={() => void reviews.decide(r, 'keep')}
                testID={`review-keep-${r.id}`}
              />
              <Button
                label={correction ? 'Skip this change' : 'Skip the bank one'}
                size="sm"
                variant="ghost"
                disabled={reviews.busyId !== null}
                onPress={() => void reviews.decide(r, 'skip')}
                testID={`review-skip-${r.id}`}
              />
            </HStack>
          )}
        </VStack>
      </Card>
    );
  };

  return (
    <Screen
      title="Bank reviews"
      subtitle="Bank transactions that look like Monefy entries"
      actions={<BackAction fallback="/history" />}
      testID="screen-bank-reviews"
    >
      {!reviews.ready ? (
        <Card>
          <EmptyState
            icon="clock"
            title="Needs your Worker"
            message="Enter its address and token in Settings, Backend."
          />
        </Card>
      ) : reviews.store.value === null ? (
        <Card>
          {reviews.store.error ? (
            <VStack gap="sm">
              <Text variant="body" testID="reviews-load-error">
                {`The list could not be loaded. ${reviews.store.error}`}
              </Text>
              <HStack>
                <Button
                  label="Try again"
                  size="sm"
                  variant="secondary"
                  onPress={() => void reviews.reload()}
                  testID="reviews-retry-load"
                />
              </HStack>
            </VStack>
          ) : (
            <Text variant="body" tone="muted" testID="reviews-loading">
              Loading from your Worker...
            </Text>
          )}
        </Card>
      ) : (
        <>
          <Text variant="caption" tone="muted">
            Keep both saves the bank transaction next to the Monefy entry; nothing is merged and the
            Monefy entry stays as it is. Skip leaves the bank transaction out; for a change to a
            saved transaction, the saved one stays as it was. There is no undo for a decision.
          </Text>
          {list.length === 0 ? (
            <Card>
              <EmptyState
                icon="check"
                title="Nothing to review"
                message="A bank transaction shows up here when it looks like a Monefy entry you already have."
                testID="reviews-empty"
              />
            </Card>
          ) : (
            <VStack gap="sm">{list.map(card)}</VStack>
          )}
          {done.length > 0 ? (
            <View style={styles.last}>
              <SectionHeader title="Decided just now" />
              <VStack gap="sm">
                {done.map((r) => (
                  <Banner key={r.id} tone="accent" icon="check">
                    <VStack gap="xxs">
                      <Text variant="bodyStrong">
                        {r.transaction.name || r.transaction.rawName}
                      </Text>
                      <Text variant="caption" tone="muted" testID={`review-done-${r.id}`}>
                        {reviews.notes[r.id]?.text ?? 'Decided.'}
                      </Text>
                    </VStack>
                  </Banner>
                ))}
              </VStack>
            </View>
          ) : null}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create((theme) => ({
  last: { paddingBottom: theme.space.lg },
}));
