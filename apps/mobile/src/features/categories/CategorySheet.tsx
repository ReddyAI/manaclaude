import type { Category } from '@manaclaude/shared';
import { useState } from 'react';
import { BottomSheet } from '../../design/components/BottomSheet';
import { Button } from '../../design/components/Button';
import { Switch, TextField } from '../../design/components/Controls';
import { HStack, VStack } from '../../design/components/Layout';
import { Text } from '../../design/components/Text';
import { errorText, isSuperseded } from '../../data/backend/client';
import { changeCategory } from './actions';
import { CATEGORY_NAME_MAX, nameProblem } from './categories';

/** Rename, leave out of budgets, archive: every change PATCH /v1/categories/:id takes besides order. */
export function CategorySheet({
  category,
  categories,
  onClose,
}: {
  category: Category | null;
  categories: readonly Category[];
  onClose: () => void;
}) {
  // The sheet keeps showing the last category while it slides away.
  const [shown, setShown] = useState<Category | null>(category);
  const [name, setName] = useState(category?.name ?? '');
  const [busy, setBusy] = useState<'name' | 'budget' | 'archive' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  if (category && category !== shown) {
    if (category.id !== shown?.id) {
      setName(category.name);
      setProblem(null);
      setNotice(null);
    }
    setShown(category);
  }

  const c = category ?? shown;
  const run = async (kind: 'name' | 'budget' | 'archive', work: () => Promise<unknown>) => {
    setBusy(kind);
    setProblem(null);
    setNotice(null);
    try {
      await work();
      return true;
    } catch (e) {
      if (!isSuperseded(e)) setProblem(errorText(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const trimmed = name.trim();
  const nameError = c ? nameProblem(name, categories, c.groupId, c.id) : null;
  const unchanged = c ? trimmed === c.name : true;

  return (
    <BottomSheet
      visible={category !== null}
      onClose={onClose}
      title={c?.name ?? 'Category'}
      testID="category-sheet"
    >
      {c ? (
        <VStack gap="lg">
          <VStack gap="sm">
            <TextField
              label="Name"
              value={name}
              onChangeText={setName}
              maxLength={CATEGORY_NAME_MAX + 20}
              error={!unchanged && nameError ? nameError : undefined}
              testID="category-name"
            />
            <Button
              label="Save the name"
              variant="secondary"
              disabled={unchanged || nameError !== null || busy !== null}
              loading={busy === 'name'}
              onPress={() =>
                void run('name', () => changeCategory(c.id, { name: trimmed })).then(
                  (ok) => ok && setNotice('Renamed.'),
                )
              }
              testID="category-save-name"
            />
          </VStack>
          <HStack gap="md" align="center" justify="space-between">
            <VStack gap="xxs" flex={1}>
              <Text variant="bodyStrong">Leave out of budgets</Text>
              <Text variant="caption" tone="muted">
                Still counted in spending and reports, with no budget line.
              </Text>
            </VStack>
            <Switch
              value={c.excludeFromBudget}
              disabled={busy !== null}
              onValueChange={(excludeFromBudget) =>
                void run('budget', () => changeCategory(c.id, { excludeFromBudget }))
              }
              accessibilityLabel="Leave out of budgets"
              testID="category-budget"
            />
          </HStack>
          <VStack gap="sm">
            <Text variant="caption" tone="muted">
              Archiving keeps the category on its transactions and in reports, and stops offering it
              when you pick one. You can bring it back later.
            </Text>
            <Button
              label="Archive"
              variant="danger"
              disabled={busy !== null}
              loading={busy === 'archive'}
              onPress={() =>
                void run('archive', () => changeCategory(c.id, { archived: true })).then(
                  (ok) => ok && onClose(),
                )
              }
              testID="category-archive"
            />
          </VStack>
          {notice ? (
            <Text variant="caption" tone="income" testID="category-notice">
              {notice}
            </Text>
          ) : null}
          {problem ? (
            <Text variant="caption" tone="danger" testID="category-sheet-problem">
              {problem}
            </Text>
          ) : null}
        </VStack>
      ) : null}
    </BottomSheet>
  );
}
