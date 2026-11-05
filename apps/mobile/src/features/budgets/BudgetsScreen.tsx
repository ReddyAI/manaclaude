import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { addMonthsToMonth, daysInMonth, formatMonth, monthOf } from '@manaclaude/shared';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { IconButton } from '../../design/components/Button';
import { Card } from '../../design/components/Card';
import { DonutChart } from '../../design/components/charts/Charts';
import { ProgressBar } from '../../design/components/Controls';
import { IconBadge, SectionHeader } from '../../design/components/Decor';
import { HStack, VStack } from '../../design/components/Layout';
import { MoneyText } from '../../design/components/MoneyText';
import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import { budgetMonth, type BudgetLine } from '../../data/metrics';
import { useLookups, useToday } from '../../data/selectors';
import { useFinance } from '../../data/store';
import { CurrencyChip } from '../currency/CurrencyChip';
import { useMoneyDisplay } from '../currency/useMoneyDisplay';

/**
 * Category budgets per month with rollover (session C owns this screen; it
 * adds editing, Flex mode and the Spending Plan).
 */
export function BudgetsScreen() {
  const data = useFinance();
  const lookups = useLookups();
  const today = useToday();
  const display = useMoneyDisplay();
  const { theme } = useUnistyles();
  const thisMonth = monthOf(today);
  const [month, setMonth] = useState(thisMonth);
  const currency = display.reportCurrency;
  const months = useMemo(
    () => [...new Set(data.budgets.map((b) => b.month))].sort(),
    [data.budgets],
  );

  const budget = useMemo(
    () => budgetMonth(data, lookups.treatment, month, currency, today),
    [data, lookups, month, currency, today],
  );
  const progressThroughMonth =
    month < thisMonth ? 1 : month > thisMonth ? 0 : Number(today.slice(8, 10)) / daysInMonth(month);
  const left = budget.totalBudgeted - budget.totalSpent;

  const groups = useMemo(() => {
    const byGroup = new Map<string, BudgetLine[]>();
    for (const line of budget.lines) {
      const cat = lookups.categoriesById.get(line.categoryId);
      const key = cat?.groupId ?? 'other';
      byGroup.set(key, [...(byGroup.get(key) ?? []), line]);
    }
    return data.categoryGroups
      .filter((g) => byGroup.has(g.id))
      .map((g) => ({
        group: g,
        lines: (byGroup.get(g.id) ?? []).sort((a, b) => b.spent - a.spent),
      }));
  }, [budget.lines, data.categoryGroups, lookups]);

  const first = months[0] ?? thisMonth;
  const last = months[months.length - 1] ?? thisMonth;

  return (
    <Screen
      title="Budgets"
      subtitle={formatMonth(month)}
      actions={<CurrencyChip />}
      testID="screen-budgets"
    >
      <HStack justify="space-between">
        <IconButton
          icon="chevron-left"
          accessibilityLabel="Previous month"
          onPress={() => month > first && setMonth(addMonthsToMonth(month, -1))}
        />
        <Text variant="headline">{formatMonth(month)}</Text>
        <IconButton
          icon="chevron-right"
          accessibilityLabel="Next month"
          onPress={() => month < last && setMonth(addMonthsToMonth(month, 1))}
        />
      </HStack>
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
                  theme.colors.category[lookups.categoriesById.get(l.categoryId)?.color ?? 'c1'],
              }))}
            center={
              <Text
                variant="label"
                tone="muted"
              >{`${Math.round((budget.totalSpent / Math.max(1, budget.totalBudgeted)) * 100)}%`}</Text>
            }
          />
          <VStack gap="xs" flex={1}>
            <Text variant="label" tone="muted">
              {left >= 0 ? 'Left to spend' : 'Over budget'}
            </Text>
            <MoneyText
              amount={Math.abs(left)}
              currency={currency}
              size="large"
              tone={left >= 0 ? 'default' : 'danger'}
              format={{ cents: 'never' }}
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
              value={budget.totalSpent / Math.max(1, budget.totalBudgeted)}
              marker={progressThroughMonth}
              accessibilityLabel="Total budget used"
            />
          </VStack>
        </HStack>
      </Card>

      {groups.map(({ group, lines }) => (
        <View key={group.id}>
          <SectionHeader title={group.name} />
          <Card padding="none">
            {lines.map((line) => {
              const cat = lookups.categoriesById.get(line.categoryId);
              const total = line.budgeted + line.rolledOver;
              const ratio = total > 0 ? line.spent / total : line.spent > 0 ? 2 : 0;
              return (
                <View
                  key={line.categoryId}
                  style={styles.line}
                  testID={`budget-${line.categoryId}`}
                >
                  <HStack gap="md">
                    <IconBadge icon={cat?.icon ?? 'circle'} color={cat?.color ?? 'c1'} size="sm" />
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
                        {line.rollover && line.rolledOver !== 0 ? ' incl. rollover' : ''}
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
              );
            })}
          </Card>
        </View>
      ))}
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
