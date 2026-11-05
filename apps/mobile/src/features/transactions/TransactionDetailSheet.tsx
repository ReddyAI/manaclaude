import { formatShortDate, type Transaction } from '@manaclaude/shared';
import { StyleSheet } from 'react-native-unistyles';
import { BottomSheet } from '../../design/components/BottomSheet';
import { Button } from '../../design/components/Button';
import { Badge } from '../../design/components/Controls';
import { Divider, HStack, VStack } from '../../design/components/Layout';
import { MoneyText } from '../../design/components/MoneyText';
import { Text } from '../../design/components/Text';
import { haptic } from '../../design/haptics';
import { useFinance } from '../../data/store';
import type { Lookups } from '../../data/selectors';
import { Amount } from '../currency/Amount';
import { setReviewed } from './actions';
import { activeLink, transferTitle } from './display';

/**
 * Basic transaction detail (session A expands it: receipts, split by items,
 * link and unlink, category picker).
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
  const current = txn ? (lookups.transactionsById.get(txn.id) ?? txn) : null;
  const link = current ? activeLink(current, lookups) : null;
  const children = current?.isSplitParent
    ? data.transactions.filter((t) => t.splitParentId === current.id)
    : [];
  const receipt = current?.receiptId
    ? data.receipts.find((r) => r.id === current.receiptId)
    : undefined;
  const category = current?.categoryId ? lookups.categoriesById.get(current.categoryId) : undefined;
  const account = current ? lookups.accountsById.get(current.accountId) : undefined;

  return (
    <BottomSheet
      visible={current !== null}
      onClose={onClose}
      title={current ? (link ? transferTitle(link, lookups) : current.name) : ''}
      scrollable
    >
      {current ? (
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
            <HStack gap="xs">
              {current.pending ? <Badge label="Pending" tone="pending" /> : null}
              {current.reviewed ? (
                <Badge label="Reviewed" tone="income" icon="check" />
              ) : (
                <Badge label="To review" tone="accent" />
              )}
              {current.aiCategoryConfidence !== null ? (
                <Badge
                  label={`AI ${Math.round(current.aiCategoryConfidence * 100)}%`}
                  tone={current.aiCategoryConfidence < 0.6 ? 'pending' : 'neutral'}
                  icon="sparkles"
                />
              ) : null}
            </HStack>
          </VStack>
          <Divider />
          <Field label="Date" value={formatShortDate(current.date)} />
          <Field label="Account" value={account?.name ?? 'Unknown'} />
          {!link ? <Field label="Category" value={category?.name ?? 'Uncategorized'} /> : null}
          <Field label="Bank description" value={current.rawName} />
          {current.notes ? <Field label="Notes" value={current.notes} /> : null}

          {link ? (
            <VStack gap="sm">
              <Text variant="label" tone="muted" uppercase>
                Both sides
              </Text>
              {[link.outTransactionId, link.inTransactionId].map((id) => {
                const side = lookups.transactionsById.get(id);
                if (!side) return null;
                return (
                  <HStack key={id} justify="space-between">
                    <Text variant="body">{lookups.accountsById.get(side.accountId)?.name}</Text>
                    <MoneyText amount={side.amount} currency={side.currency} colorize="signed" />
                  </HStack>
                );
              })}
              {link.outCurrency !== link.inCurrency ? (
                <Text variant="caption" tone="muted" numeric>
                  {`Rate you got: 1 ${link.outCurrency} = ${link.impliedRate.toFixed(4)} ${link.inCurrency}`}
                </Text>
              ) : null}
            </VStack>
          ) : null}

          {children.length > 0 ? (
            <VStack gap="sm">
              <Text variant="label" tone="muted" uppercase>
                Split into
              </Text>
              {children.map((c) => (
                <HStack key={c.id} justify="space-between">
                  <Text variant="body">
                    {lookups.categoriesById.get(c.categoryId ?? '')?.name ?? c.name}
                  </Text>
                  <MoneyText amount={c.amount} currency={c.currency} />
                </HStack>
              ))}
            </VStack>
          ) : null}

          {receipt ? (
            <VStack gap="sm">
              <Text variant="label" tone="muted" uppercase>
                {`Receipt · ${receipt.merchant ?? ''}`}
              </Text>
              {receipt.lineItems.map((li) => (
                <HStack key={li.id} justify="space-between">
                  <Text variant="caption">
                    {li.quantity && li.quantity !== '1'
                      ? `${li.quantity} x ${li.description}`
                      : li.description}
                  </Text>
                  <MoneyText
                    amount={li.amount}
                    currency={receipt.currency ?? current.currency}
                    size="small"
                  />
                </HStack>
              ))}
              {receipt.tip ? (
                <HStack justify="space-between">
                  <Text variant="caption" tone="muted">
                    Tip
                  </Text>
                  <MoneyText
                    amount={receipt.tip}
                    currency={receipt.currency ?? current.currency}
                    size="small"
                    tone="muted"
                  />
                </HStack>
              ) : null}
            </VStack>
          ) : null}

          <Button
            label={current.reviewed ? 'Mark as not reviewed' : 'Mark reviewed'}
            icon={current.reviewed ? undefined : 'check'}
            variant={current.reviewed ? 'secondary' : 'primary'}
            onPress={() => {
              if (!current.reviewed) haptic('confirm');
              setReviewed(current.id, !current.reviewed);
            }}
            fullWidth
          />
        </VStack>
      ) : null}
    </BottomSheet>
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
