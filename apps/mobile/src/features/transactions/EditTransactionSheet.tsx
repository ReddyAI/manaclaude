import type { Transaction } from '@manaclaude/shared';
import { useState } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { BottomSheet } from '../../design/components/BottomSheet';
import { Button } from '../../design/components/Button';
import { Chip, SegmentedControl, Switch, TextField } from '../../design/components/Controls';
import { HStack, VStack } from '../../design/components/Layout';
import { Text } from '../../design/components/Text';
import { haptic } from '../../design/haptics';
import { useToday } from '../../data/selectors';
import { useFinanceSelector } from '../../data/store';
import { editTransaction } from './actions';
import {
  checkEdit,
  draftFrom,
  editLocks,
  KIND_OPTIONS,
  NAME_MAX,
  NOTES_MAX,
  type EditDraft,
} from './edit';

/**
 * Change name, date, amount, notes, kind, tags and "left out of reports"
 * (PATCH /v1/transactions/:id). One save sends only what changed.
 */
export function EditTransactionSheet({
  txn,
  visible,
  onClose,
}: {
  txn: Transaction;
  visible: boolean;
  onClose: () => void;
}) {
  const tags = useFinanceSelector((d) => d.tags);
  const today = useToday();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<EditDraft>(() => draftFrom(txn));
  const [tried, setTried] = useState(false);
  // A fresh form every time the sheet opens, from the transaction as it is now.
  if (visible !== open) {
    setOpen(visible);
    if (visible) {
      setDraft(draftFrom(txn));
      setTried(false);
    }
  }

  const locks = editLocks(txn);
  const check = checkEdit(txn, draft, today, tags);
  const changed = check.patch !== null && Object.keys(check.patch).length > 0;
  const set = (patch: Partial<EditDraft>) => setDraft({ ...draft, ...patch });
  const shown = (field: keyof typeof check.problems) =>
    tried || field === 'name' || field === 'notes' ? check.problems[field] : undefined;

  const save = () => {
    setTried(true);
    if (!check.patch || !changed) return;
    haptic('confirm');
    editTransaction(txn.id, check.patch);
    onClose();
  };

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title="Edit transaction"
      scrollable
      testID="edit-transaction-sheet"
    >
      <VStack gap="md" style={styles.body}>
        <TextField
          label="Name"
          value={draft.name}
          onChangeText={(name) => set({ name })}
          maxLength={NAME_MAX + 20}
          error={shown('name')}
          testID="edit-name"
        />
        {locks.splitWhole ? (
          <Text variant="caption" tone="muted" testID="edit-split-whole">
            {
              'This transaction is split, so only its name and notes are changed here. Date, amount, kind, tags and "left out" belong to its parts.'
            }
          </Text>
        ) : (
          <>
            <TextField
              label="Date (YYYY-MM-DD)"
              value={draft.date}
              onChangeText={(date) => set({ date })}
              autoCapitalize="none"
              autoCorrect={false}
              error={shown('date')}
              testID="edit-date"
            />
            {locks.amount ? (
              <VStack gap="xxs">
                <Text variant="label" tone="muted">
                  Amount
                </Text>
                <Text variant="caption" tone="muted" testID="edit-amount-locked">
                  {locks.amount}
                </Text>
              </VStack>
            ) : (
              <VStack gap="sm">
                <SegmentedControl
                  accessibilityLabel="Money out or in"
                  value={draft.direction}
                  onChange={(direction) => set({ direction })}
                  options={[
                    { value: 'out', label: 'Money out' },
                    { value: 'in', label: 'Money in' },
                  ]}
                />
                <TextField
                  label={`Amount (${txn.currency})`}
                  value={draft.amount}
                  onChangeText={(amount) => set({ amount })}
                  keyboardType="decimal-pad"
                  error={shown('amount')}
                  testID="edit-amount"
                />
                {txn.originalCurrency !== txn.currency ? (
                  <Text variant="caption" tone="muted">
                    {`The amount charged in ${txn.originalCurrency} stays as it was.`}
                  </Text>
                ) : null}
              </VStack>
            )}
            <VStack gap="xs">
              <Text variant="label" tone="muted">
                Kind
              </Text>
              {locks.kind ? (
                <Text variant="caption" tone="muted" testID="edit-kind-locked">
                  {locks.kind}
                </Text>
              ) : (
                <HStack gap="xs" wrap>
                  {KIND_OPTIONS.map((k) => (
                    <Chip
                      key={k.kind}
                      label={k.label}
                      selected={draft.kind === k.kind}
                      onPress={() => set({ kind: k.kind })}
                      testID={`edit-kind-${k.kind}`}
                    />
                  ))}
                </HStack>
              )}
            </VStack>
            <VStack gap="xs">
              <Text variant="label" tone="muted">
                Tags
              </Text>
              {tags.length === 0 ? (
                <Text variant="caption" tone="muted" testID="edit-no-tags">
                  There are no tags yet, and the Worker has no way to make one from here.
                </Text>
              ) : (
                <HStack gap="xs" wrap>
                  {tags.map((t) => {
                    const on = draft.tagIds.includes(t.id);
                    return (
                      <Chip
                        key={t.id}
                        label={t.name}
                        selected={on}
                        onPress={() =>
                          set({
                            tagIds: on
                              ? draft.tagIds.filter((id) => id !== t.id)
                              : [...draft.tagIds, t.id],
                          })
                        }
                        testID={`edit-tag-${t.id}`}
                      />
                    );
                  })}
                </HStack>
              )}
            </VStack>
            <HStack gap="md" align="center" justify="space-between">
              <View style={styles.flex}>
                <Text variant="bodyStrong">Leave out of reports and budgets</Text>
                <Text variant="caption" tone="muted">
                  It stays in the account, but no total counts it.
                </Text>
              </View>
              <Switch
                value={draft.excluded}
                onValueChange={(excluded) => set({ excluded })}
                accessibilityLabel="Leave out of reports and budgets"
                testID="edit-excluded"
              />
            </HStack>
          </>
        )}
        <TextField
          label="Notes"
          value={draft.notes}
          onChangeText={(notes) => set({ notes })}
          multiline
          maxLength={NOTES_MAX + 50}
          error={shown('notes')}
          testID="edit-notes"
        />
        <Text variant="caption" tone="muted">
          Each field you change stays yours: syncs, imports, rules and the AI will not change it
          again. Editing an amount does not change the account balance.
        </Text>
        <HStack gap="sm">
          <Button
            label="Save"
            disabled={!changed && check.patch !== null}
            onPress={save}
            testID="edit-save"
          />
          <Button label="Cancel" variant="ghost" onPress={onClose} testID="edit-cancel" />
        </HStack>
      </VStack>
    </BottomSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { paddingBottom: theme.space.md },
  flex: { flex: 1, gap: theme.space.xxs },
}));
