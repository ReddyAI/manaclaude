import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import {
  addMonthsToMonth,
  daysInMonth,
  formatMonth,
  monthOf,
  type BudgetFlexType,
  type BudgetLine,
  type Category,
} from '@manaclaude/shared';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Button, IconButton } from '../../design/components/Button';
import { Card } from '../../design/components/Card';
import { DonutChart } from '../../design/components/charts/Charts';
import { Chip, ProgressBar, SegmentedControl } from '../../design/components/Controls';
import { EmptyState, IconBadge, SectionHeader } from '../../design/components/Decor';
import { HStack, VStack } from '../../design/components/Layout';
import { MoneyText } from '../../design/components/MoneyText';
import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import { useLookups, useToday } from '../../data/selectors';
import { useSettings } from '../../data/settingsStore';
import { useFinance } from '../../data/store';
import { DualAmount } from '../currency/Amount';
import { CurrencyChip } from '../currency/CurrencyChip';
import { pickDual, useMoneyDisplay } from '../currency/useMoneyDisplay';
import { goTo } from '../planning/navigate';
import { copyBudgetsFromPreviousMonth } from './actions';
import { BudgetEditSheet } from './BudgetEditSheet';
import { SpendingPlanView } from './SpendingPlanView';
import { useBudgetData } from './useBudgetData';

const FLEX_GROUPS: { type: BudgetFlexType; title: string; hint: string }[] = [
  { type: 'fixed', title: 'Fixed', hint: 'Bills that are the same every month' },
  { type: 'flexible', title: 'Flexible', hint: 'Everyday spending you can adjust' },
  { type: 'non_monthly', title: 'Non-monthly', hint: 'Costs that come a few times a year' },
];

type View_ = 'budget' | 'plan';

/**
 * Category budgets per month with rollover, optional Flex grouping and the
 * Spending Plan (session C).
 */
export function BudgetsScreen() {
  const data = useFinance();
  const lookups = useLookups();
  const today = useToday();
  const display = useMoneyDisplay();
  const settings = useSettings();
  const { theme } = useUnistyles();
  const flexMode = settings.flexBudgeting ?? false;
  const thisMonth = monthOf(today);
  const [month, setMonth] = useState(thisMonth);
  const [view, setView] = useState<View_>('budget');
  const [editing, setEditing] = useState<{ categoryId: string | null } | null>(null);
  const currency = display.reportCurrency;

  const months = useMemo(
    () => [...new Set(data.budgets.map((b) => b.month))].sort(),
    [data.budgets],
  );
  const first = months[0] ?? thisMonth;
  const last = months[months.length - 1] ?? thisMonth;
  const lastAllowed = addMonthsToMonth(thisMonth > last ? thisMonth : last, 1);

  const result = useBudgetData(month);
  const budget = result.main;
  const progressThroughMonth =
    month < thisMonth ? 1 : month > thisMonth ? 0 : Number(today.slice(8, 10)) / daysInMonth(month);
  const left = budget.totalBudgeted - budget.totalSpent;
  const used = budget.totalSpent / Math.max(1, budget.totalBudgeted);

  const groups = useMemo(() => {
    const sortLines = (lines: BudgetLine[]) => [...lines].sort((a, b) => b.spent - a.spent);
    if (flexMode) {
      return FLEX_GROUPS.map((g) => ({
        id: g.type,
        title: g.title,
        hint: g.hint,
        lines: sortLines(budget.lines.filter((l) => (l.flexType ?? 'flexible') === g.type)),
      })).filter((g) => g.lines.length > 0);
    }
    return data.categoryGroups
      .map((g) => ({
        id: g.id,
        title: g.name,
        hint: '',
        lines: sortLines(
          budget.lines.filter((l) => lookups.categoriesById.get(l.categoryId)?.groupId === g.id),
        ),
      }))
      .filter((g) => g.lines.length > 0);
  }, [budget.lines, data.categoryGroups, lookups, flexMode]);

  const choices: Category[] = useMemo(() => {
    const have = new Set(budget.lines.map((l) => l.categoryId));
    return data.categories.filter((c) => c.kind === 'expense' && !have.has(c.id));
  }, [data.categories, budget.lines]);

  const editLine = editing?.categoryId
    ? (data.budgets.find((b) => b.month === month && b.categoryId === editing.categoryId) ?? null)
    : null;
  const categoryName = (id: string) => lookups.categoriesById.get(id)?.name ?? id;
  const hasLater = months.some((m) => m > month);

  return (
    <Screen
      title="Budgets"
      subtitle={formatMonth(month)}
      actions={<CurrencyChip />}
      testID="screen-budgets"
    >
      <SegmentedControl
        accessibilityLabel="Budgets view"
        value={view}
        onChange={setView}
        options={[
          { value: 'budget', label: 'Budget' },
          { value: 'plan', label: 'Spending plan' },
        ]}
      />
      <HStack justify="space-between">
        <IconButton
          icon="chevron-left"
          accessibilityLabel="Previous month"
          onPress={() => month > first && setMonth(addMonthsToMonth(month, -1))}
        />
        <Text variant="headline" testID="budget-month">
          {formatMonth(month)}
        </Text>
        <IconButton
          icon="chevron-right"
          accessibilityLabel="Next month"
          onPress={() => month < lastAllowed && setMonth(addMonthsToMonth(month, 1))}
        />
      </HStack>

      {view === 'plan' ? (
        <SpendingPlanView month={month} />
      ) : budget.lines.length === 0 ? (
        <EmptyState
          icon="chart-pie"
          title={`No budgets for ${formatMonth(month)}`}
          message="Start from last month and adjust what you need."
          actionLabel="Copy last month's budgets"
          onAction={() => copyBudgetsFromPreviousMonth(month)}
        />
      ) : (
        <>
          <Card>
            <HStack gap="lg" align="center">
              <DonutChart
                size="small"
                accessibilityLabel="Budget used by category"
                segments={budget.lines
                  .filter((l) => l.spent > 0)
                  .map((l) => ({
                    key: l.categoryId,
                    value: l.spent,
                    color:
                      theme.colors.category[
                        lookups.categoriesById.get(l.categoryId)?.color ?? 'c1'
                      ],
                  }))}
                center={<Text variant="label" tone="muted">{`${Math.round(used * 100)}%`}</Text>}
              />
              <VStack gap="xs" flex={1}>
                <Text variant="label" tone="muted">
                  {left >= 0 ? 'Left to spend' : 'Over budget'}
                </Text>
                <DualAmount
                  {...pickDual(display, result, (r) => Math.abs(r.totalBudgeted - r.totalSpent))}
                  size="large"
                  align="left"
                  tone={left >= 0 ? 'default' : 'danger'}
                  format={{ cents: 'never' }}
                  testID="budget-left"
                />
                <Text variant="caption" tone="muted">
                  <MoneyText
                    amount={budget.totalSpent}
                    currency={currency}
                    size="small"
                    tone="muted"
                    format={{ cents: 'never' }}
                  />{' '}
                  spent of{' '}
                  <MoneyText
                    amount={budget.totalBudgeted}
                    currency={currency}
                    size="small"
                    tone="muted"
                    format={{ cents: 'never' }}
                  />
                </Text>
                <ProgressBar
                  value={used}
                  marker={progressThroughMonth}
                  accessibilityLabel="Total budget used"
                />
              </VStack>
            </HStack>
          </Card>

          {groups.map((group) => {
            const groupAvail = group.lines.reduce((s, l) => s + l.available, 0);
            return (
              <View key={group.id} testID={`budget-group-${group.id}`}>
                <SectionHeader
                  title={group.title}
                  trailing={
                    <Text variant="caption" tone="muted" numeric>
                      <MoneyText
                        amount={Math.abs(groupAvail)}
                        currency={currency}
                        size="small"
                        tone={groupAvail < 0 ? 'danger' : 'muted'}
                        format={{ cents: 'never' }}
                      />
                      {groupAvail < 0 ? ' over' : ' left'}
                    </Text>
                  }
                />
                {group.hint ? (
                  <Text variant="caption" tone="faint">
                    {group.hint}
                  </Text>
                ) : null}
                <Card padding="none">
                  {group.lines.map((line) => {
                    const cat = lookups.categoriesById.get(line.categoryId);
                    const total = line.budgeted + line.rolledOver;
                    const ratio = total > 0 ? line.spent / total : line.spent > 0 ? 2 : 0;
                    return (
                      <Pressable
                        key={line.categoryId}
                        accessibilityRole="button"
                        accessibilityLabel={`Edit ${cat?.name ?? line.categoryId} budget`}
                        onPress={() => setEditing({ categoryId: line.categoryId })}
                        testID={`budget-${line.categoryId}`}
                      >
                        <View style={styles.line}>
                          <HStack gap="md">
                            <IconBadge
                              icon={cat?.icon ?? 'circle'}
                              color={cat?.color ?? 'c1'}
                              size="sm"
                            />
                            <VStack flex={1} gap="xxs">
                              <Text variant="bodyStrong" numberOfLines={1}>
                                {cat?.name ?? line.categoryId}
                              </Text>
                              <Text variant="caption" tone="muted" numeric>
                                <MoneyText
                                  amount={line.spent}
                                  currency={currency}
                                  size="small"
                                  tone="muted"
                                  format={{ cents: 'never' }}
                                />{' '}
                                of{' '}
                                <MoneyText
                                  amount={total}
                                  currency={currency}
                                  size="small"
                                  tone="muted"
                                  format={{ cents: 'never' }}
                                />
                                {line.rollover && line.rolledOver !== 0
                                  ? line.rolledOver > 0
                                    ? ' incl. rollover'
                                    : ' after overspend carried'
                                  : ''}
                              </Text>
                            </VStack>
                            <VStack align="flex-end" gap="xxs">
                              <MoneyText
                                amount={Math.abs(line.available)}
                                currency={currency}
                                tone={line.available < 0 ? 'danger' : 'default'}
                                format={{ cents: 'never' }}
                              />
                              <Text variant="caption" tone="muted">
                                {line.available < 0 ? 'over' : 'left'}
                              </Text>
                            </VStack>
                          </HStack>
                          <ProgressBar
                            value={ratio}
                            color={theme.colors.category[cat?.color ?? 'c1']}
                            marker={progressThroughMonth}
                            accessibilityLabel={`${cat?.name} budget used`}
                          />
                        </View>
                      </Pressable>
                    );
                  })}
                </Card>
              </View>
            );
          })}

          {budget.unbudgetedSpent !== 0 ? (
            <Text variant="caption" tone="muted" align="center">
              <MoneyText
                amount={budget.unbudgetedSpent}
                currency={currency}
                size="small"
                tone="muted"
              />{' '}
              spent in categories without a budget
            </Text>
          ) : null}
          <Button
            label="Add a budget"
            icon="plus"
            variant="secondary"
            onPress={() => setEditing({ categoryId: null })}
            testID="budget-add"
          />
        </>
      )}

      <HStack gap="sm" wrap>
        <Chip label="Weekly recap" onPress={() => goTo('/recaps/weekly')} />
        <Chip label="Month in review" onPress={() => goTo('/recaps/month')} />
        <Chip label="Retirement plan" onPress={() => goTo('/planning')} />
      </HStack>

      {editing ? (
        <BudgetEditSheet
          key={`${month}-${editing.categoryId ?? 'new'}`}
          visible
          onClose={() => setEditing(null)}
          month={month}
          existing={editLine}
          choices={choices}
          currency={settings.primaryCurrency}
          flexMode={flexMode}
          defaultRollover={settings.defaultRollover ?? false}
          hasLaterMonths={hasLater}
          categoryName={categoryName}
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create((theme) => ({
  line: {
    gap: theme.space.sm,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.md,
    borderBottomWidth: theme.size.hairline,
    borderColor: theme.colors.border,
  },
}));
