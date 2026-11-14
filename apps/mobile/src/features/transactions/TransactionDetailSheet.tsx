import { useState } from 'react';
import { formatShortDate, type Transaction } from '@manaclaude/shared';
import { StyleSheet } from 'react-native-unistyles';
import { BottomSheet } from '../../design/components/BottomSheet';
import { Button } from '../../design/components/Button';
import { Badge } from '../../design/components/Controls';
import { Icon } from '../../design/components/Icon';
import { Divider, HStack, VStack } from '../../design/components/Layout';
import { MoneyText } from '../../design/components/MoneyText';
import { PressableScale } from '../../design/components/PressableScale';
import { Text } from '../../design/components/Text';
import { haptic } from '../../design/haptics';
import { useFinance } from '../../data/store';
import type { Lookups } from '../../data/selectors';
import { Amount } from '../currency/Amount';
import { setCategory, setReviewed, undoSplit, type CashDeleteOutcome } from './actions';
import { CashDeleteSection } from './CashDeleteSection';
import { CategoryPicker } from './CategoryPicker';
import { activeLink, suggestedLink, transferTitle } from './display';
import { kindLabel } from './edit';
import { EditTransactionSheet } from './EditTransactionSheet';
import { LOW_CONFIDENCE } from './reviewQueue';
import { ReceiptSection } from './ReceiptSection';
import { TransferSection } from './TransferSection';

/**
 * Transaction detail (session A): amounts, category picker, linked transfer
 * with both sides and unlink, receipt with line items, split by items.
 */
export function TransactionDetailSheet({
  txn,
  lookups,
  onClose,
}: {
  txn: Transaction | null;
  lookups: Lookups;
  onClose: () => void;
}) {
  const data = useFinance();
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deleted, setDeleted] = useState<{
    id: string;
    outcome: Extract<CashDeleteOutcome, { kind: 'deleted' }>;
  } | null>(null);
  const gone = deleted && txn && deleted.id === txn.id ? deleted.outcome : null;
  const current = txn ? (lookups.transactionsById.get(txn.id) ?? txn) : null;
  // The edit form belongs to the transaction it was opened on.
  if ((!current || gone) && editing) setEditing(false);
  if ((!current || gone) && picking) setPicking(false);
  const link = current ? activeLink(current, lookups) : null;
  const suggestion = current ? suggestedLink(current, lookups) : null;
  const children = current?.isSplitParent
    ? data.transactions.filter((t) => t.splitParentId === current.id)
    : [];
  const receipt = current?.receiptId
    ? data.receipts.find((r) => r.id === current.receiptId)
    : undefined;
  const category = current?.categoryId ? lookups.categoriesById.get(current.categoryId) : undefined;
  const account = current ? lookups.accountsById.get(current.accountId) : undefined;
  const canEditCategory = !!current && !link && !current.isSplitParent;

  return (
    <>
      <BottomSheet
        visible={current !== null}
        onClose={onClose}
        title={
          gone
            ? 'Cash entry deleted'
            : current
              ? link
                ? transferTitle(link, lookups)
                : current.name
              : ''
        }
        scrollable
        testID="transaction-detail"
      >
        {gone ? (
          <VStack gap="md" style={styles.body} testID="cash-deleted">
            <Text variant="body" testID="cash-deleted-text">
              {gone.text}
            </Text>
            {gone.receipts > 0 ? (
              <VStack gap="sm">
                <Text variant="body" tone="muted">
                  {gone.receipts === 1
                    ? 'Its receipt is kept and now waits to be attached to another transaction.'
                    : `Its ${gone.receipts} receipts are kept and now wait to be attached to another transaction.`}
                </Text>
              </VStack>
            ) : null}
            <Button label="Done" onPress={onClose} fullWidth testID="cash-deleted-done" />
          </VStack>
        ) : current ? (
          <VStack gap="md" style={styles.body}>
            <VStack gap="xs" align="center">
              <Amount
                amount={current.amount}
                currency={current.currency}
                date={current.date}
                size="large"
                colorize="flow"
                align="center"
              />
              {current.originalCurrency !== current.currency ? (
                <Text variant="caption" tone="muted" numeric>
                  Charged as{' '}
                  <MoneyText
                    amount={current.originalAmount}
                    currency={current.originalCurrency}
                    size="small"
                    tone="muted"
                  />
                </Text>
              ) : null}
              <HStack gap="xs" wrap justify="center">
                {current.pending ? <Badge label="Pending" tone="pending" /> : null}
                {current.excluded ? <Badge label="Left out of reports" tone="neutral" /> : null}
                {current.reviewed ? (
                  <Badge label="Reviewed" tone="income" icon="check" />
                ) : (
                  <Badge label="To review" tone="accent" />
                )}
                {current.aiCategoryConfidence !== null ? (
                  <Badge
                    label={`AI ${Math.round(current.aiCategoryConfidence * 100)}%`}
                    tone={current.aiCategoryConfidence < LOW_CONFIDENCE ? 'pending' : 'neutral'}
                    icon="sparkles"
                  />
                ) : null}
              </HStack>
            </VStack>
            <Divider />
            <Field label="Date" value={formatShortDate(current.date)} />
            <Field label="Account" value={account?.name ?? 'Unknown'} />
            {!link ? (
              canEditCategory ? (
                <PressableScale
                  onPress={() => setPicking(true)}
                  pressHaptic="tap"
                  accessibilityLabel={`Category ${category?.name ?? 'Uncategorized'}. Change.`}
                  testID="change-category"
                >
                  <HStack justify="space-between">
                    <Text variant="body" tone="muted">
                      Category
                    </Text>
                    <HStack gap="xs">
                      <Text variant="body" tone={category ? 'default' : 'pending'}>
                        {category?.name ?? 'Uncategorized'}
                      </Text>
                      <Icon name="chevron-right" size="sm" tone="faint" />
                    </HStack>
                  </HStack>
                </PressableScale>
              ) : (
                <Field label="Category" value={category?.name ?? 'Uncategorized'} />
              )
            ) : null}
            <Field label="Bank description" value={current.rawName} />
            {current.kind !== 'regular' ? (
              <Field label="Kind" value={kindLabel(current.kind)} />
            ) : null}
            {current.tagIds.length > 0 ? (
              <Field
                label="Tags"
                value={current.tagIds
                  .map(
                    (id) => data.tags.find((t) => t.id === id)?.name ?? 'A tag not on this device',
                  )
                  .join(', ')}
              />
            ) : null}
            {current.notes ? <Field label="Notes" value={current.notes} /> : null}
            <HStack>
              <Button
                label="Edit"
                icon="sliders-horizontal"
                variant="secondary"
                size="sm"
                onPress={() => setEditing(true)}
                testID="edit-transaction"
              />
            </HStack>

            <TransferSection txn={current} link={link} suggestion={suggestion} lookups={lookups} />

            {children.length > 0 ? (
              <VStack gap="sm" testID="split-children">
                <Text variant="label" tone="muted" uppercase>
                  Split into
                </Text>
                {children.map((c) => (
                  <HStack key={c.id} justify="space-between">
                    <VStack flex={1}>
                      <Text variant="body">
                        {lookups.categoriesById.get(c.categoryId ?? '')?.name ?? c.name}
                      </Text>
                      {c.notes ? (
                        <Text variant="caption" tone="muted" numberOfLines={1}>
                          {c.notes}
                        </Text>
                      ) : null}
                    </VStack>
                    <MoneyText amount={c.amount} currency={c.currency} />
                  </HStack>
                ))}
                <HStack>
                  <Button
                    label="Undo split"
                    variant="secondary"
                    size="sm"
                    onPress={() => {
                      haptic('tap');
                      undoSplit(current.id);
                    }}
                    testID="undo-split"
                  />
                </HStack>
              </VStack>
            ) : null}

            {!link && !current.splitParentId ? (
              <ReceiptSection txn={current} receipt={receipt} />
            ) : null}

            <CashDeleteSection
              txn={current}
              onDeleted={(outcome) => setDeleted({ id: current.id, outcome })}
            />

            <Button
              label={current.reviewed ? 'Mark as not reviewed' : 'Mark reviewed'}
              icon={current.reviewed ? undefined : 'check'}
              variant={current.reviewed ? 'secondary' : 'primary'}
              onPress={() => {
                if (!current.reviewed) haptic('confirm');
                setReviewed(current.id, !current.reviewed);
              }}
              fullWidth
              testID="toggle-reviewed"
            />
          </VStack>
        ) : null}
      </BottomSheet>
      {current && !gone ? (
        <EditTransactionSheet txn={current} visible={editing} onClose={() => setEditing(false)} />
      ) : null}
      {current && !gone ? (
        <CategoryPicker
          visible={picking}
          onClose={() => setPicking(false)}
          selectedId={current.categoryId}
          onPick={(c) => {
            haptic('confirm');
            setCategory(current.id, c.id);
            setPicking(false);
          }}
        />
      ) : null}
    </>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <HStack justify="space-between" align="flex-start">
      <Text variant="body" tone="muted">
        {label}
      </Text>
      <Text variant="body" style={styles.value} align="right">
        {value}
      </Text>
    </HStack>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { paddingBottom: theme.space.md },
  value: { flex: 1, marginLeft: theme.space.lg },
}));
