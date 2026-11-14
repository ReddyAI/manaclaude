import { useMemo, useRef, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { formatShortDate, type Receipt, type Transaction } from '@manaclaude/shared';
import { Button } from '../../design/components/Button';
import { Card } from '../../design/components/Card';
import { HStack, VStack } from '../../design/components/Layout';
import { MoneyText } from '../../design/components/MoneyText';
import { Text } from '../../design/components/Text';
import { haptic } from '../../design/haptics';
import { useBackendConfig } from '../../data/backend/config';
import { useLookups } from '../../data/selectors';
import { useFinance } from '../../data/store';
import {
  attachReceiptOnWorker,
  checkAttached,
  uploadReceiptForMatches,
  type AttachOutcome,
  type ReceiptUploadOutcome,
} from './actions';
import { matchesView, noMatchText, reasonText, type LikelyPurchase } from './receiptMatches';

export type ReceiptUploadState =
  { phase: 'idle' } | { phase: 'sending' } | { phase: 'done'; outcome: ReceiptUploadOutcome };

/**
 * Sends a receipt photo once (a second tap while it is on its way does
 * nothing) and keeps the Worker's answer for the matches view. Everything is
 * dropped when the backend changes.
 */
export function useReceiptUpload() {
  const config = useBackendConfig();
  const [state, setState] = useState<ReceiptUploadState>({ phase: 'idle' });
  const sending = useRef(false);
  // Closing the view drops an answer still on its way (the data reloads anyway).
  const generation = useRef(0);
  const [shownScope, setShownScope] = useState(config.scope);
  if (shownScope !== config.scope) {
    setShownScope(config.scope);
    setState({ phase: 'idle' });
  }
  const start = async (localUri: string) => {
    if (sending.current) return;
    sending.current = true;
    const gen = generation.current;
    setState({ phase: 'sending' });
    try {
      const outcome = await uploadReceiptForMatches(localUri);
      if (gen === generation.current)
        setState(outcome ? { phase: 'done', outcome } : { phase: 'idle' });
    } finally {
      sending.current = false;
    }
  };
  const reset = () => {
    generation.current += 1;
    setState({ phase: 'idle' });
  };
  return { state, start, reset };
}

function purchaseTitle(p: LikelyPurchase): string {
  return p.txn?.name ?? 'A purchase not loaded on this device yet';
}

/**
 * What happened to a receipt photo sent without a transaction: the purchase
 * the Worker attached it to, or its likely purchases with its reason, each
 * attached with one tap (POST /v1/receipts/:id/attach).
 */
export function ReceiptMatches({
  state,
  onDone,
  onOpenInbox,
}: {
  state: ReceiptUploadState;
  onDone: () => void;
  /** Opens Receipts to attach; left out where that is the screen already shown. */
  onOpenInbox?: () => void;
}) {
  if (state.phase === 'idle') return null;
  if (state.phase === 'sending')
    return (
      <Text variant="body" tone="muted" testID="receipt-upload-sending">
        Sending the receipt to your Worker and reading it. This can take a minute.
      </Text>
    );
  const { outcome } = state;
  const inbox = onOpenInbox ? (
    <Button
      label="Open Receipts to attach"
      variant="secondary"
      onPress={onOpenInbox}
      testID="receipt-upload-inbox"
    />
  ) : null;
  const done = <Button label="Done" onPress={onDone} testID="receipt-upload-done" />;
  if (outcome.kind === 'refused')
    return (
      <VStack gap="md">
        <Text variant="body" tone="danger" testID="receipt-upload-refused">
          {outcome.text}
        </Text>
        {done}
      </VStack>
    );
  if (outcome.kind === 'unsure')
    return (
      <VStack gap="md">
        <Text variant="body" testID="receipt-upload-unsure">
          {outcome.text}
        </Text>
        {outcome.found ? <FoundReceipt receipt={outcome.found} /> : null}
        {inbox}
        {done}
      </VStack>
    );
  return (
    <UploadedReceipt
      receiptId={outcome.response.receipt.id}
      fallback={outcome.response.receipt}
      response={outcome.response}
      inbox={inbox}
      done={done}
    />
  );
}

/** After a lost answer: where the receipt that arrived is now. */
function FoundReceipt({ receipt }: { receipt: Receipt }) {
  const lookups = useLookups();
  const txn = receipt.matchedTransactionId
    ? lookups.transactionsById.get(receipt.matchedTransactionId)
    : undefined;
  return (
    <Text variant="body" testID="receipt-upload-found">
      {txn
        ? `Your Worker attached it to "${txn.name}" on ${formatShortDate(txn.date)}.`
        : 'It is waiting in Receipts to attach, where you can pick its purchase.'}
    </Text>
  );
}

function UploadedReceipt({
  receiptId,
  fallback,
  response,
  inbox,
  done,
}: {
  receiptId: string;
  fallback: Receipt;
  response: Parameters<typeof matchesView>[0];
  inbox: ReactNode;
  done: ReactNode;
}) {
  const data = useFinance();
  const lookups = useLookups();
  const receipt = data.receipts.find((r) => r.id === receiptId) ?? fallback;
  const view = useMemo(() => matchesView(response, data.transactions), [response, data]);
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ result: AttachOutcome; txnId: string } | null>(null);
  const sending = useRef(false);

  const run = async (txnId: string, call: () => Promise<AttachOutcome | null>) => {
    if (sending.current) return;
    sending.current = true;
    setBusy(txnId);
    try {
      const result = await call();
      if (!result) return;
      setOutcome({ result, txnId });
      haptic(result.kind === 'attached' ? 'confirm' : 'reject');
    } finally {
      sending.current = false;
      setBusy(null);
    }
  };

  const nameOf = (id: string) => lookups.transactionsById.get(id)?.name ?? 'that purchase';
  const attachedByYou = outcome?.result.kind === 'attached' ? outcome.txnId : null;
  if (attachedByYou)
    return (
      <VStack gap="md">
        <Text variant="body" tone="income" testID="receipt-match-attached">
          {`Attached to "${nameOf(attachedByYou)}".`}
        </Text>
        {done}
      </VStack>
    );

  const workerMatched =
    view.matched && receipt.matchedTransactionId === view.matched.match.transactionId
      ? view.matched
      : null;
  // The Worker's data no longer has it on the purchase it matched (it was moved
  // or its match undone): offer that purchase again with the others.
  const likely = workerMatched || !view.matched ? view.likely : [view.matched, ...view.likely];

  return (
    <VStack gap="md">
      {workerMatched ? (
        <Card>
          <VStack gap="xs">
            <Text variant="bodyStrong" testID="receipt-auto-matched">
              {workerMatched.txn
                ? `Your Worker attached it to "${workerMatched.txn.name}" on ${formatShortDate(workerMatched.txn.date)}.`
                : 'Your Worker attached it to a purchase that is not loaded on this device yet.'}
            </Text>
            <Text variant="caption" tone="muted">
              {`${reasonText(workerMatched.match.reason)}.`}
            </Text>
            {workerMatched.txn ? (
              <MoneyText
                amount={workerMatched.txn.amount}
                currency={workerMatched.txn.currency}
                size="small"
              />
            ) : null}
          </VStack>
        </Card>
      ) : null}

      {outcome && outcome.result.kind !== 'attached' ? (
        <Text
          variant="caption"
          tone="danger"
          testID={
            outcome.result.kind === 'unsure' ? 'receipt-match-unsure' : 'receipt-match-refused'
          }
        >
          {outcome.result.text}
        </Text>
      ) : null}
      {outcome?.result.kind === 'unsure' ? (
        <Button
          label="Check again"
          variant="secondary"
          loading={busy !== null}
          onPress={() => void run(outcome.txnId, () => checkAttached(receiptId, outcome.txnId))}
          testID="receipt-match-check"
        />
      ) : null}

      {likely.length > 0 ? (
        <VStack gap="sm">
          <Text variant="label" tone="muted">
            {workerMatched ? 'Not this one? Other likely purchases' : 'Likely purchases'}
          </Text>
          {likely.map((p) => (
            <Candidate
              key={p.match.transactionId}
              purchase={p}
              account={p.txn ? lookups.accountsById.get(p.txn.accountId)?.name : undefined}
              busy={busy === p.match.transactionId}
              disabled={busy !== null || outcome?.result.kind === 'unsure'}
              onAttach={() =>
                void run(p.match.transactionId, () =>
                  attachReceiptOnWorker(receiptId, p.match.transactionId),
                )
              }
            />
          ))}
        </VStack>
      ) : !workerMatched ? (
        <VStack gap="xs">
          <Text variant="body" testID="receipt-match-none">
            {noMatchText(receipt)}
          </Text>
          <Text variant="caption" tone="muted">
            It waits in Receipts to attach, where you can pick its purchase yourself.
          </Text>
        </VStack>
      ) : null}
      {!workerMatched ? inbox : null}
      {done}
    </VStack>
  );
}

function Candidate({
  purchase,
  account,
  busy,
  disabled,
  onAttach,
}: {
  purchase: LikelyPurchase;
  account: string | undefined;
  busy: boolean;
  disabled: boolean;
  onAttach: () => void;
}) {
  const txn: Transaction | null = purchase.txn;
  const id = purchase.match.transactionId;
  return (
    <View style={styles.candidate} testID={`receipt-likely-${id}`}>
      <HStack gap="sm" align="flex-start">
        <VStack flex={1} gap="xxs">
          <Text variant="bodyStrong" numberOfLines={1}>
            {purchaseTitle(purchase)}
          </Text>
          {txn ? (
            <Text variant="caption" tone="muted" numberOfLines={1}>
              {[formatShortDate(txn.date), account].filter(Boolean).join(' · ')}
            </Text>
          ) : null}
          <Text variant="caption" tone="muted" testID={`receipt-likely-reason-${id}`}>
            {reasonText(purchase.match.reason)}
          </Text>
        </VStack>
        {txn ? <MoneyText amount={txn.amount} currency={txn.currency} size="small" /> : null}
      </HStack>
      <Button
        label="Attach"
        size="sm"
        variant="secondary"
        loading={busy}
        disabled={disabled}
        accessibilityLabel={`Attach to ${purchaseTitle(purchase)}`}
        onPress={onAttach}
        testID={`receipt-likely-attach-${id}`}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  candidate: {
    gap: theme.space.sm,
    padding: theme.space.md,
    borderRadius: theme.radius.md,
    borderWidth: theme.size.hairline,
    borderColor: theme.colors.border,
  },
}));
