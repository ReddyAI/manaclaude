import { useRef, useState } from 'react';
import type { Transaction } from '@manaclaude/shared';
import { Button } from '../../design/components/Button';
import { HStack, VStack } from '../../design/components/Layout';
import { Text } from '../../design/components/Text';
import { haptic } from '../../design/haptics';
import { useBackendStatus } from '../../data/backend/status';
import { canSaveToBackend } from '../../data/backend/sync';
import { useFinanceSelector } from '../../data/store';
import { checkCashDeleted, deleteCashEntry, type CashDeleteOutcome } from './actions';
import { cashDeleteCheck } from './cashDelete';

/**
 * "Delete this cash entry" on a transaction's detail, offered only for an
 * entry the Worker can delete (cashDelete.ts). Asks once more, then waits for
 * the Worker. A refusal is said in plain words; a deletion is reported to the
 * detail sheet, which shows how far the cash balance moved.
 */
export function CashDeleteSection({
  txn,
  onDeleted,
}: {
  txn: Transaction;
  onDeleted: (outcome: Extract<CashDeleteOutcome, { kind: 'deleted' }>) => void;
}) {
  useBackendStatus();
  const accounts = useFinanceSelector((d) => d.accounts);
  const transferLinks = useFinanceSelector((d) => d.transferLinks);
  const [shownId, setShownId] = useState(txn.id);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<CashDeleteOutcome | null>(null);
  // Set at the moment of the tap: a second tap must not send a second delete.
  const sending = useRef(false);
  if (shownId !== txn.id) {
    setShownId(txn.id);
    setAsking(false);
    setMessage(null);
  }

  const check = cashDeleteCheck(txn, { accounts, transferLinks });
  // Sample data is never sent; the entry must be this backend's.
  if (!canSaveToBackend()) return null;
  if (!check.offer) {
    return check.todo ? (
      <Text variant="caption" tone="muted" testID="cash-delete-todo">
        {check.todo}
      </Text>
    ) : null;
  }

  const run = async (call: () => Promise<CashDeleteOutcome | null>) => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    try {
      const outcome = await call();
      if (!outcome) return;
      if (outcome.kind === 'deleted') {
        haptic('confirm');
        onDeleted(outcome);
      } else {
        haptic('reject');
        setMessage(outcome);
        setAsking(false);
      }
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  if (message?.kind === 'unsure') {
    return (
      <VStack gap="sm" testID="cash-delete-unsure">
        <Text variant="caption" tone="danger">
          {message.text}
        </Text>
        <HStack>
          <Button
            label="Check again"
            variant="secondary"
            size="sm"
            loading={busy}
            onPress={() => void run(() => checkCashDeleted(txn.id))}
            testID="cash-delete-check"
          />
        </HStack>
      </VStack>
    );
  }

  return (
    <VStack gap="sm" testID="cash-delete">
      {message ? (
        <Text variant="caption" tone="danger" testID="cash-delete-refused">
          {message.text}
        </Text>
      ) : null}
      {asking ? (
        <VStack gap="sm">
          <Text variant="body" testID="cash-delete-ask">
            {`Delete "${txn.name}" from your Worker for good? The cash balance moves back by what this entry did to it. Its receipt, if any, is kept.`}
          </Text>
          <HStack gap="sm">
            <Button
              label="Delete"
              variant="danger"
              size="sm"
              loading={busy}
              onPress={() => void run(() => deleteCashEntry(txn.id))}
              testID="cash-delete-confirm"
            />
            <Button
              label="Keep it"
              variant="secondary"
              size="sm"
              onPress={() => setAsking(false)}
            />
          </HStack>
        </VStack>
      ) : (
        <HStack>
          <Button
            label="Delete this cash entry"
            variant="ghost"
            size="sm"
            onPress={() => {
              haptic('tap');
              setMessage(null);
              setAsking(true);
            }}
            testID="cash-delete-start"
          />
        </HStack>
      )}
    </VStack>
  );
}
