import { useMemo, useState } from 'react';
import {
  parseMoneyInput,
  toMajor,
  type BudgetFlexType,
  type Category,
  type CategoryBudget,
  type CurrencyCode,
  type YearMonth,
} from '@manaclaude/shared';
import { Button } from '../../design/components/Button';
import { Chip, SegmentedControl, Switch, TextField } from '../../design/components/Controls';
import { BottomSheet } from '../../design/components/BottomSheet';
import { HStack, VStack } from '../../design/components/Layout';
import { Text } from '../../design/components/Text';
import { haptic } from '../../design/haptics';
import { removeBudget, saveBudget } from './actions';

export interface BudgetEditSheetProps {
  visible: boolean;
  onClose: () => void;
  month: YearMonth;
  /** The line being edited; null adds a new budget (pick a category from `choices`). */
  existing: CategoryBudget | null;
  /** Expense categories that have no budget this month. */
  choices: readonly Category[];
  currency: CurrencyCode;
  flexMode: boolean;
  defaultRollover: boolean;
  hasLaterMonths: boolean;
  categoryName: (id: string) => string;
}

/** Edit one category's monthly budget: amount, rollover, Flex type. Mount with a key per target. */
export function BudgetEditSheet({
  visible,
  onClose,
  month,
  existing,
  choices,
  currency,
  flexMode,
  defaultRollover,
  hasLaterMonths,
  categoryName,
}: BudgetEditSheetProps) {
  const cur = existing?.currency ?? currency;
  const [categoryId, setCategoryId] = useState<string | null>(existing?.categoryId ?? null);
  const [text, setText] = useState(existing ? String(toMajor(existing.amount, cur)) : '');
  const [rollover, setRollover] = useState(existing?.rollover ?? defaultRollover);
  const [flexType, setFlexType] = useState<BudgetFlexType>(existing?.flexType ?? 'flexible');
  const [later, setLater] = useState(false);

  const parsed = useMemo(
    () => (text.trim() === '' ? null : parseMoneyInput(text, cur)),
    [text, cur],
  );
  const invalid = text.trim() !== '' && (parsed === null || parsed < 0);
  const canSave = categoryId !== null && parsed !== null && parsed >= 0;

  const save = () => {
    if (!categoryId || parsed === null) return;
    saveBudget({
      categoryId,
      month,
      amount: parsed,
      currency: cur,
      rollover,
      flexType: flexMode ? flexType : (existing?.flexType ?? null),
      applyToLaterMonths: later,
    });
    haptic('confirm');
    onClose();
  };

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title={existing ? categoryName(existing.categoryId) : 'Add a budget'}
      scrollable
      testID="budget-edit-sheet"
    >
      <VStack gap="md">
        {existing ? null : (
          <VStack gap="xs">
            <Text variant="label" tone="muted">
              Category
            </Text>
            <HStack gap="xs" wrap>
              {choices.map((c) => (
                <Chip
                  key={c.id}
                  label={c.name}
                  selected={categoryId === c.id}
                  onPress={() => setCategoryId(c.id)}
                />
              ))}
            </HStack>
          </VStack>
        )}
        <TextField
          label={`Budget for the month (${cur})`}
          value={text}
          onChangeText={setText}
          keyboardType="decimal-pad"
          placeholder="0"
          error={invalid ? 'Enter an amount like 250 or 249.99' : undefined}
          testID="budget-amount-input"
        />
        <HStack justify="space-between">
          <VStack flex={1} gap="xxs">
            <Text variant="bodyStrong">Roll over</Text>
            <Text variant="caption" tone="muted">
              Carry what is left (or overspent) into next month
            </Text>
          </VStack>
          <Switch
            value={rollover}
            onValueChange={setRollover}
            accessibilityLabel="Roll over"
            testID="budget-rollover-switch"
          />
        </HStack>
        {flexMode ? (
          <VStack gap="xs">
            <Text variant="label" tone="muted">
              Flex type
            </Text>
            <SegmentedControl
              accessibilityLabel="Flex type"
              value={flexType}
              onChange={setFlexType}
              options={[
                { value: 'fixed', label: 'Fixed' },
                { value: 'flexible', label: 'Flexible' },
                { value: 'non_monthly', label: 'Non-monthly' },
              ]}
            />
          </VStack>
        ) : null}
        {hasLaterMonths && existing ? (
          <HStack justify="space-between">
            <VStack flex={1}>
              <Text variant="body">Apply to later months too</Text>
            </VStack>
            <Switch
              value={later}
              onValueChange={setLater}
              accessibilityLabel="Apply to later months"
            />
          </HStack>
        ) : null}
        <HStack gap="sm">
          {existing ? (
            <Button
              label="Remove"
              variant="danger"
              onPress={() => {
                removeBudget(month, existing.categoryId);
                haptic('reject');
                onClose();
              }}
              testID="budget-remove"
            />
          ) : null}
          <Button label="Save" onPress={save} disabled={!canSave} fullWidth testID="budget-save" />
        </HStack>
      </VStack>
    </BottomSheet>
  );
}
