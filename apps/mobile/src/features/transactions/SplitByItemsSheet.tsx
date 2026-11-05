import { useMemo, useState } from 'react';
import {
  parseMoneyInput,
  type Receipt,
  type ReceiptLineItem,
  type Transaction,
} from '@manaclaude/shared';
import { StyleSheet } from 'react-native-unistyles';
import { BottomSheet } from '../../design/components/BottomSheet';
import { Button } from '../../design/components/Button';
import { TextField } from '../../design/components/Controls';
import { Divider, HStack, VStack } from '../../design/components/Layout';
import { ListRow } from '../../design/components/ListRow';
import { MoneyText } from '../../design/components/MoneyText';
import { Text } from '../../design/components/Text';
import { haptic } from '../../design/haptics';
import { useFinance } from '../../data/store';
import { newId, setReceiptItems, splitTransaction } from './actions';
import { CategoryPicker } from './CategoryPicker';
import { buildItemSplitLines, itemCategory, type ItemCategories } from './receiptSplit';

/**
 * "Split by items": each receipt item gets a category (its suggestion, else
 * the transaction's own), and items in the same category become one line. Tax
 * and tip are spread over the items so the lines add up to the card charge
 * exactly. Items can be added by hand until the AI reads receipts.
 */
export function SplitByItemsSheet({
  txn,
  receipt,
  visible,
  onClose,
}: {
  txn: Transaction;
  receipt: Receipt;
  visible: boolean;
  onClose: () => void;
}) {
  const data = useFinance();
  const categoriesById = useMemo(
    () => new Map(data.categories.map((c) => [c.id, c])),
    [data.categories],
  );
  const [chosen, setChosen] = useState<ItemCategories>({});
  const [pickFor, setPickFor] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [error, setError] = useState<string | null>(null);

  const items = receipt.lineItems;
  const plan = useMemo(() => buildItemSplitLines(txn, items, chosen), [txn, items, chosen]);
  const priceMinor = parseMoneyInput(price, txn.currency);
  const canAdd = description.trim().length > 0 && priceMinor !== null && priceMinor > 0;

  const addItem = () => {
    if (!canAdd || priceMinor === null) return;
    const item: ReceiptLineItem = {
      id: newId('li'),
      description: description.trim(),
      quantity: '1',
      amount: priceMinor,
      categoryId: null,
    };
    setReceiptItems(receipt.id, [...items, item]);
    setDescription('');
    setPrice('');
  };

  const confirm = () => {
    if (!plan.ok) return;
    const problem = splitTransaction(txn.id, plan.lines);
    if (problem) {
      haptic('reject');
      setError(problem);
      return;
    }
    haptic('confirm');
    setError(null);
    onClose();
  };

  return (
    <>
      <BottomSheet
        visible={visible}
        onClose={onClose}
        title="Split by items"
        scrollable
        testID="split-sheet"
      >
        <VStack gap="md" style={styles.body}>
          <Text variant="caption" tone="muted">
            Pick a category for each item. Tax and tip are spread over the items, so the lines add
            up to the charge exactly.
          </Text>
          {items.length === 0 ? (
            <Text variant="body" tone="muted">
              This receipt has no items yet. Add them below.
            </Text>
          ) : (
            <VStack>
              {items.map((item) => {
                const category = categoriesById.get(itemCategory(item, txn, chosen) ?? '');
                return (
                  <ListRow
                    key={item.id}
                    title={item.description}
                    subtitle={category?.name ?? 'Uncategorized'}
                    trailing={
                      <MoneyText
                        amount={item.amount}
                        currency={receipt.currency ?? txn.currency}
                        size="small"
                      />
                    }
                    onPress={() => setPickFor(item.id)}
                    showChevron
                    testID={`split-item-${item.id}`}
                  />
                );
              })}
            </VStack>
          )}

          <HStack gap="sm" align="flex-end">
            <VStack flex={2}>
              <TextField
                label="Add an item"
                placeholder="Item"
                value={description}
                onChangeText={setDescription}
                testID="split-add-description"
              />
            </VStack>
            <VStack flex={1}>
              <TextField
                placeholder="Price"
                value={price}
                onChangeText={setPrice}
                keyboardType="decimal-pad"
                accessibilityLabel="Item price"
                testID="split-add-price"
              />
            </VStack>
            <Button
              label="Add"
              onPress={addItem}
              disabled={!canAdd}
              variant="secondary"
              testID="split-add"
            />
          </HStack>

          <Divider />
          <Text variant="label" tone="muted" uppercase>
            Result
          </Text>
          {plan.ok ? (
            plan.lines.map((line) => (
              <HStack key={line.categoryId ?? 'none'} justify="space-between">
                <VStack flex={1}>
                  <Text variant="body">
                    {categoriesById.get(line.categoryId ?? '')?.name ?? 'Uncategorized'}
                  </Text>
                  <Text variant="caption" tone="muted" numberOfLines={1}>
                    {line.notes}
                  </Text>
                </VStack>
                <MoneyText amount={line.amount} currency={txn.currency} testID="split-line" />
              </HStack>
            ))
          ) : (
            <Text variant="caption" tone="danger" testID="split-problem">
              {plan.error}
            </Text>
          )}
          {error ? (
            <Text variant="caption" tone="danger">
              {error}
            </Text>
          ) : null}
          <Button
            label={plan.ok ? `Split into ${plan.lines.length} lines` : 'Split'}
            icon="split"
            onPress={confirm}
            disabled={!plan.ok}
            fullWidth
            testID="split-confirm"
          />
        </VStack>
      </BottomSheet>
      <CategoryPicker
        visible={pickFor !== null}
        onClose={() => setPickFor(null)}
        title="Item category"
        onPick={(category) => {
          if (pickFor) setChosen((c) => ({ ...c, [pickFor]: category.id }));
          setPickFor(null);
        }}
      />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { paddingBottom: theme.space.md },
}));
