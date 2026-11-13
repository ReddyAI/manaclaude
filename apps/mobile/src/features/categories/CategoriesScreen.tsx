import type { Category } from '@manaclaude/shared';
import { useEffect, useState } from 'react';
import { RefreshControl, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Button, IconButton } from '../../design/components/Button';
import { Card } from '../../design/components/Card';
import { Banner, EmptyState, IconBadge, SectionHeader } from '../../design/components/Decor';
import { HStack, VStack } from '../../design/components/Layout';
import { ListRow } from '../../design/components/ListRow';
import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import { errorText, isSuperseded } from '../../data/backend/client';
import { isBackendReady, useBackendConfig } from '../../data/backend/config';
import { useFinanceSelector } from '../../data/store';
import { BackAction } from '../planning/BackAction';
import { categoriesStore, changeCategory, moveCategory } from './actions';
import { AddCategorySheet } from './AddCategorySheet';
import { CategorySheet } from './CategorySheet';
import { sectionCategories, type CategorySection } from './categories';

/**
 * Categories as the Worker has them (GET /v1/categories). What can be changed
 * is exactly what PATCH /v1/categories/:id takes: the name, archived, left out
 * of budgets, and the order. New ones go into an existing group (POST). The
 * Worker has no delete, merge or group editing, so none is offered.
 */
export function CategoriesScreen() {
  const config = useBackendConfig();
  const ready = isBackendReady(config);
  const { value: categories, loading, error } = categoriesStore.use();
  const groups = useFinanceSelector((d) => d.categoryGroups);
  const { theme } = useUnistyles();
  const [pulling, setPulling] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // Nothing opened or reported for another backend stays on screen.
  const [shownScope, setShownScope] = useState(config.scope);
  if (shownScope !== config.scope) {
    setShownScope(config.scope);
    setEditing(null);
    setAdding(false);
    setProblem(null);
  }

  useEffect(() => {
    if (ready) void categoriesStore.load();
  }, [ready, config.scope]);

  if (!ready) {
    return (
      <Screen
        title="Categories"
        actions={<BackAction fallback="/settings" />}
        testID="screen-categories"
      >
        <Card>
          <EmptyState
            icon="cloud-off"
            title="Set up the backend first"
            message="Categories are kept by your Worker. Enter its address and your API token in Settings, Backend."
          />
        </Card>
      </Screen>
    );
  }

  const run = async (id: string, work: () => Promise<unknown>) => {
    setBusy(id);
    setProblem(null);
    try {
      await work();
    } catch (e) {
      if (!isSuperseded(e)) setProblem(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const { sections, archived } = sectionCategories(categories ?? [], groups);
  const editingCategory = categories?.find((c) => c.id === editing) ?? null;

  const row = (section: CategorySection, c: Category, index: number) => (
    <ListRow
      key={c.id}
      title={c.name}
      subtitle={c.excludeFromBudget ? 'Left out of budgets' : undefined}
      leading={<IconBadge icon={c.icon} color={c.color} size="sm" />}
      onPress={() => setEditing(c.id)}
      accessibilityLabel={`${c.name}, change`}
      testID={`category-row-${c.id}`}
      trailing={
        <HStack gap="xxs">
          <IconButton
            icon="chevron-up"
            accessibilityLabel={`Move ${c.name} up`}
            disabled={index === 0 || busy !== null}
            onPress={() => void run(c.id, () => moveCategory(section.active, c.id, -1))}
            testID={`category-up-${c.id}`}
          />
          <IconButton
            icon="chevron-down"
            accessibilityLabel={`Move ${c.name} down`}
            disabled={index === section.active.length - 1 || busy !== null}
            onPress={() => void run(c.id, () => moveCategory(section.active, c.id, 1))}
            testID={`category-down-${c.id}`}
          />
        </HStack>
      }
    />
  );

  return (
    <Screen
      title="Categories"
      actions={
        <HStack gap="xs">
          <IconButton
            icon="refresh-cw"
            accessibilityLabel="Reload categories"
            onPress={() => void categoriesStore.load()}
            testID="categories-reload"
          />
          <BackAction fallback="/settings" />
        </HStack>
      }
      refreshControl={
        <RefreshControl
          refreshing={pulling}
          tintColor={theme.colors.accent}
          colors={[theme.colors.accent]}
          onRefresh={() => {
            setPulling(true);
            void categoriesStore.load().finally(() => setPulling(false));
          }}
        />
      }
      testID="screen-categories"
    >
      {error ? (
        <Banner tone="danger" icon="triangle-alert">
          <Text variant="caption" testID="categories-error">
            {error}
          </Text>
        </Banner>
      ) : null}
      {problem ? (
        <Banner tone="danger" icon="triangle-alert">
          <Text variant="caption" testID="categories-problem">
            {problem}
          </Text>
        </Banner>
      ) : null}
      {categories === null ? (
        loading ? (
          <Text variant="caption" tone="muted" testID="categories-loading">
            Loading...
          </Text>
        ) : null
      ) : (
        <>
          <VStack gap="sm">
            <Text variant="caption" tone="muted">
              Tap a category to rename it, leave it out of budgets or archive it. An archived
              category stays on its transactions and in reports but is no longer offered when you
              pick one. Categories cannot be deleted or merged here, and groups cannot be changed.
            </Text>
            <Button
              label="Add a category"
              icon="plus"
              variant="secondary"
              onPress={() => setAdding(true)}
              testID="category-add"
            />
          </VStack>
          {sections.map((s) => (
            <View key={s.groupId} testID={`category-group-${s.groupId}`}>
              <SectionHeader title={s.title} />
              <Card padding="none">
                {s.active.length === 0 ? (
                  <View style={styles.empty}>
                    <Text variant="caption" tone="muted">
                      No categories in use.
                    </Text>
                  </View>
                ) : (
                  s.active.map((c, i) => row(s, c, i))
                )}
              </Card>
            </View>
          ))}
          {archived.length > 0 ? (
            <View testID="category-archived">
              <SectionHeader title="Archived" />
              <Card padding="none">
                {archived.map((c) => (
                  <ListRow
                    key={c.id}
                    title={c.name}
                    subtitle={sections.find((s) => s.groupId === c.groupId)?.title}
                    leading={<IconBadge icon={c.icon} color={c.color} size="sm" />}
                    dimmed
                    testID={`category-row-${c.id}`}
                    trailing={
                      <Button
                        label="Bring back"
                        size="sm"
                        variant="ghost"
                        loading={busy === c.id}
                        disabled={busy !== null && busy !== c.id}
                        onPress={() =>
                          void run(c.id, () => changeCategory(c.id, { archived: false }))
                        }
                        testID={`category-restore-${c.id}`}
                      />
                    }
                  />
                ))}
              </Card>
            </View>
          ) : null}
        </>
      )}
      <CategorySheet
        category={editingCategory}
        categories={categories ?? []}
        onClose={() => setEditing(null)}
      />
      <AddCategorySheet
        visible={adding}
        sections={sections}
        categories={categories ?? []}
        onClose={() => setAdding(false)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create((theme) => ({
  empty: { paddingHorizontal: theme.space.lg, paddingVertical: theme.space.md },
}));
