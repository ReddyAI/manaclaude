import { useMemo, useRef, useState } from 'react';
import { formatShortDate, type Receipt, type Transaction } from '@manaclaude/shared';
import { BottomSheet } from '../../design/components/BottomSheet';
import { Button } from '../../design/components/Button';
import { Card } from '../../design/components/Card';
import { Badge, TextField } from '../../design/components/Controls';
import { EmptyState } from '../../design/components/Decor';
import { HStack, VStack } from '../../design/components/Layout';
import { ListRow } from '../../design/components/ListRow';
import { MoneyText } from '../../design/components/MoneyText';
import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import { haptic } from '../../design/haptics';
import { isBackendReady, useBackendConfig } from '../../data/backend/config';
import { useBackendStatus } from '../../data/backend/status';
import { canSaveToBackend } from '../../data/backend/sync';
import { useRefreshControl } from '../../data/backend/useRefreshControl';
import { useLookups } from '../../data/selectors';
import { useFinance } from '../../data/store';
import { BackAction } from '../planning/BackAction';
import { attachReceiptOnWorker, checkAttached, type AttachOutcome } from './actions';
import { ReceiptImage } from './ReceiptImage';
import { attachCandidates, receiptsToAttach, waitingReason } from './receiptInbox';

/**
 * Receipts with no transaction, or whose match the Worker was not sure of
 * (including receipts left behind when their cash entry was deleted). Read
 * from the dataset. Opening one shows its photo (from this device, or read
 * from the Worker and not kept) and the transactions it could belong to;
 * picking one attaches it with POST /v1/receipts/:id/attach.
 */
export function ReceiptsToAttachScreen() {
  const ready = isBackendReady(useBackendConfig());
  useBackendStatus();
  const data = useFinance();
  const refreshControl = useRefreshControl();
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useMemo(() => receiptsToAttach(data), [data]);
  const live = ready && canSaveToBackend();
  const open = openId ? (data.receipts.find((r) => r.id === openId) ?? null) : null;

  return (
    <Screen
      title="Receipts to attach"
      actions={<BackAction fallback="/transactions" />}
      refreshControl={refreshControl}
      testID="screen-receipts-to-attach"
    >
      {!ready ? (
        <Card>
          <EmptyState
            icon="cloud-off"
            title="Set up the backend first"
            message="Receipts are kept by your Worker. Enter its address and your API token in Settings, Backend."
          />
        </Card>
      ) : !live ? (
        <Card>
          <EmptyState
            icon="receipt"
            title="Your data has not loaded yet"
            message="Pull down to load your data from your Worker."
          />
        </Card>
      ) : list.length === 0 ? (
        <Card>
          <EmptyState
            icon="receipt"
            title="Nothing to attach"
            message="Receipts that have no transaction, or whose match needs checking, are listed here."
          />
        </Card>
      ) : (
        <>
          <Text variant="caption" tone="muted">
            Tap a receipt to see it and pick the purchase it belongs to.
          </Text>
          <Card padding="none">
            {list.map((r) => (
              <ListRow
                key={r.id}
                title={r.merchant ?? 'Receipt'}
                subtitle={[r.date ? formatShortDate(r.date) : 'Date not read', waitingReason(r)]
                  .filter(Boolean)
                  .join(' · ')}
                trailing={
                  <VStack align="flex-end" gap="xxs">
                    {r.total !== null && r.currency ? (
                      <MoneyText amount={r.total} currency={r.currency} size="small" />
                    ) : null}
                    {r.status === 'failed' ? <Badge label="Not read" tone="danger" /> : null}
                    {r.matchedTransactionId ? <Badge label="Check match" tone="pending" /> : null}
                  </VStack>
                }
                onPress={() => setOpenId(r.id)}
                showChevron
                testID={`receipt-to-attach-${r.id}`}
              />
            ))}
          </Card>
        </>
      )}
      <AttachReceiptSheet receipt={open} onClose={() => setOpenId(null)} />
    </Screen>
  );
}

function AttachReceiptSheet({
  receipt,
  onClose,
}: {
  receipt: Receipt | null;
  onClose: () => void;
}) {
  const data = useFinance();
  const lookups = useLookups();
  const [shownId, setShownId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Transaction | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<AttachOutcome | null>(null);
  const [attachedTo, setAttachedTo] = useState<string | null>(null);
  const sending = useRef(false);
  const id = receipt?.id ?? null;
  if (id !== shownId) {
    setShownId(id);
    setQuery('');
    setPicked(null);
    setOutcome(null);
    setAttachedTo(null);
  }

  const candidates = useMemo(
    () => (receipt ? attachCandidates(receipt, data.transactions, query) : []),
    [receipt, data.transactions, query],
  );

  const run = async (call: () => Promise<AttachOutcome | null>, name: string) => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setOutcome(null);
    try {
      const result = await call();
      if (!result) return;
      setOutcome(result);
      if (result.kind === 'attached') {
        haptic('confirm');
        setAttachedTo(name);
      } else {
        haptic('reject');
        if (result.kind === 'refused') setPicked(null);
      }
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  return (
    <BottomSheet
      visible={receipt !== null}
      onClose={onClose}
      title={receipt?.merchant ?? 'Receipt'}
      scrollable
      testID="attach-receipt-sheet"
    >
      {attachedTo ? (
        <VStack gap="md">
          <Text variant="body" tone="income" testID="attach-done">
            {`Attached to "${attachedTo}".`}
          </Text>
          <Button label="Done" onPress={onClose} testID="attach-done-button" />
        </VStack>
      ) : receipt ? (
        <VStack gap="md">
          <ReceiptImage receipt={receipt} compact testID="attach-receipt-image" />
          <VStack gap="xxs">
            <Text variant="caption" tone="muted">
              {[
                receipt.date ? formatShortDate(receipt.date) : 'Date not read',
                waitingReason(receipt),
              ].join(' · ')}
            </Text>
            {receipt.total !== null && receipt.currency ? (
              <MoneyText amount={receipt.total} currency={receipt.currency} size="small" />
            ) : null}
          </VStack>

          {outcome && outcome.kind !== 'attached' ? (
            <Text
              variant="caption"
              tone="danger"
              testID={outcome.kind === 'unsure' ? 'attach-unsure' : 'attach-refused'}
            >
              {outcome.text}
            </Text>
          ) : null}

          {outcome?.kind === 'unsure' && picked ? (
            <Button
              label="Check again"
              variant="secondary"
              loading={busy}
              onPress={() => void run(() => checkAttached(receipt.id, picked.id), picked.name)}
              testID="attach-check"
            />
          ) : picked ? (
            <VStack gap="sm">
              <Text variant="body" testID="attach-ask">
                {`Attach this receipt to "${picked.name}" on ${formatShortDate(picked.date)}?`}
              </Text>
              <HStack gap="sm">
                <Button
                  label="Attach"
                  loading={busy}
                  onPress={() =>
                    void run(() => attachReceiptOnWorker(receipt.id, picked.id), picked.name)
                  }
                  testID="attach-confirm"
                />
                <Button label="Back" variant="secondary" onPress={() => setPicked(null)} />
              </HStack>
            </VStack>
          ) : (
            <VStack gap="sm">
              <Text variant="label" tone="muted">
                Which purchase is it for?
              </Text>
              <TextField
                label="Search"
                value={query}
                onChangeText={setQuery}
                placeholder="Name of the purchase"
                testID="attach-search"
              />
              {candidates.length === 0 ? (
                <Text variant="caption" tone="muted" testID="attach-none">
                  No purchase without a receipt matches. Splits, linked transfers and purchases that
                  already have a receipt are not listed.
                </Text>
              ) : (
                candidates.map((t) => (
                  <ListRow
                    key={t.id}
                    title={t.name}
                    subtitle={[
                      formatShortDate(t.date),
                      lookups.accountsById.get(t.accountId)?.name,
                      t.id === receipt.matchedTransactionId ? 'Attached now' : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    trailing={<MoneyText amount={t.amount} currency={t.currency} size="small" />}
                    onPress={() => {
                      haptic('tap');
                      setOutcome(null);
                      setPicked(t);
                    }}
                    testID={`attach-candidate-${t.id}`}
                  />
                ))
              )}
            </VStack>
          )}
        </VStack>
      ) : null}
    </BottomSheet>
  );
}
