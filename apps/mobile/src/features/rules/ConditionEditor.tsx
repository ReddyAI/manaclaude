import { useMemo } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Button } from '../../design/components/Button';
import { Chip, Switch, TextField } from '../../design/components/Controls';
import { HStack, VStack } from '../../design/components/Layout';
import { Text } from '../../design/components/Text';
import { useFinanceSelector } from '../../data/store';
import {
  AMOUNT_OPS,
  CONDITION_FIELDS,
  TEXT_OPS,
  newCondition,
  type ConditionDraft,
  type ListField,
} from './rules';

/** The currencies the app works in, plus any an account uses. */
const BASE_CURRENCIES = ['USD', 'INR'];

function useChoices(field: ListField, selected: readonly string[]) {
  const data = useFinanceSelector((d) => d);
  return useMemo(() => {
    let options: { value: string; label: string }[];
    if (field === 'accountId') options = data.accounts.map((a) => ({ value: a.id, label: a.name }));
    else if (field === 'categoryId')
      options = data.categories
        .filter((c) => !c.archived || selected.includes(c.id))
        .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
        .map((c) => ({ value: c.id, label: c.archived ? `${c.name} (archived)` : c.name }));
    else
      options = [...new Set([...BASE_CURRENCIES, ...data.accounts.map((a) => a.currency)])]
        .sort()
        .map((c) => ({ value: c, label: c }));
    // An id the rule holds that is not in the data on this device still shows, so it can be removed.
    for (const v of selected)
      if (!options.some((o) => o.value === v))
        options.push({ value: v, label: field === 'currency' ? v : 'Not on this device' });
    return options;
  }, [data, field, selected]);
}

function ListValues({
  draft,
  onChange,
}: {
  draft: Extract<ConditionDraft, { field: ListField }>;
  onChange: (d: ConditionDraft) => void;
}) {
  const options = useChoices(draft.field, draft.values);
  return (
    <VStack gap="xs">
      <Text variant="caption" tone="muted">
        Pick one, or several to match any of them.
      </Text>
      <HStack gap="xs" wrap>
        {options.map((o) => {
          const on = draft.values.includes(o.value);
          return (
            <Chip
              key={o.value}
              label={o.label}
              selected={on}
              onPress={() =>
                onChange({
                  ...draft,
                  values: on
                    ? draft.values.filter((v) => v !== o.value)
                    : [...draft.values, o.value],
                })
              }
              testID={`cond-${draft.key}-value-${o.value}`}
            />
          );
        })}
      </HStack>
    </VStack>
  );
}

/** One condition of the rule form. */
export function ConditionEditor({
  draft,
  index,
  problem,
  onChange,
  onRemove,
}: {
  draft: ConditionDraft;
  index: number;
  problem: string | null;
  onChange: (d: ConditionDraft) => void;
  onRemove: () => void;
}) {
  return (
    <View style={styles.box} testID={`cond-${index}`}>
      <VStack gap="sm">
        <HStack gap="xs" wrap>
          {CONDITION_FIELDS.map((f) => (
            <Chip
              key={f.field}
              label={f.label}
              selected={draft.field === f.field}
              onPress={() =>
                draft.field !== f.field && onChange({ ...newCondition(f.field), key: draft.key })
              }
              testID={`cond-${index}-field-${f.field}`}
            />
          ))}
        </HStack>
        {draft.field === 'name' || draft.field === 'rawName' ? (
          <>
            {draft.field === 'rawName' ? (
              <Text variant="caption" tone="muted">
                The name as the bank or the file sent it, before any renaming.
              </Text>
            ) : null}
            <HStack gap="xs" wrap>
              {TEXT_OPS.map((o) => (
                <Chip
                  key={o.op}
                  label={o.label}
                  selected={draft.op === o.op}
                  onPress={() => onChange({ ...draft, op: o.op })}
                  testID={`cond-${index}-op-${o.op}`}
                />
              ))}
            </HStack>
            <TextField
              label={draft.op === 'regex' ? 'Pattern (regular expression)' : 'Text'}
              value={draft.text}
              onChangeText={(text) => onChange({ ...draft, text })}
              autoCapitalize="none"
              autoCorrect={false}
              testID={`cond-${index}-text`}
            />
            <HStack gap="md" align="center" justify="space-between">
              <Text variant="caption">Upper and lower case must match exactly</Text>
              <Switch
                value={draft.caseSensitive}
                onValueChange={(caseSensitive) => onChange({ ...draft, caseSensitive })}
                accessibilityLabel="Upper and lower case must match exactly"
                testID={`cond-${index}-case`}
              />
            </HStack>
          </>
        ) : draft.field === 'amount' ? (
          <>
            <Text variant="caption" tone="muted">
              The size of the amount in the transaction&apos;s own currency, whether money went out
              or came in: 50 means 50.00 either way.
            </Text>
            <HStack gap="xs" wrap>
              {AMOUNT_OPS.map((o) => (
                <Chip
                  key={o.op}
                  label={o.label}
                  selected={draft.op === o.op}
                  onPress={() => onChange({ ...draft, op: o.op })}
                  testID={`cond-${index}-op-${o.op}`}
                />
              ))}
            </HStack>
            <HStack gap="sm">
              <View style={styles.half}>
                <TextField
                  label={draft.op === 'between' ? 'From' : 'Amount'}
                  value={draft.amount}
                  onChangeText={(amount) => onChange({ ...draft, amount })}
                  keyboardType="decimal-pad"
                  testID={`cond-${index}-amount`}
                />
              </View>
              {draft.op === 'between' ? (
                <View style={styles.half}>
                  <TextField
                    label="To"
                    value={draft.upTo}
                    onChangeText={(upTo) => onChange({ ...draft, upTo })}
                    keyboardType="decimal-pad"
                    testID={`cond-${index}-upto`}
                  />
                </View>
              ) : null}
            </HStack>
          </>
        ) : draft.field === 'accountId' ||
          draft.field === 'categoryId' ||
          draft.field === 'currency' ? (
          <ListValues draft={draft} onChange={onChange} />
        ) : null}
        {problem ? (
          <Text variant="caption" tone="danger" testID={`cond-${index}-problem`}>
            {problem}
          </Text>
        ) : null}
        <HStack justify="flex-end">
          <Button
            label="Remove"
            size="sm"
            variant="ghost"
            onPress={onRemove}
            testID={`cond-${index}-remove`}
          />
        </HStack>
      </VStack>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  box: {
    padding: theme.space.md,
    borderRadius: theme.radius.md,
    borderWidth: theme.size.hairline,
    borderColor: theme.colors.border,
  },
  half: { flex: 1 },
}));
