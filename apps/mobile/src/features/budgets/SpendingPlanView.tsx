import { useMemo, useState } from 'react';
import { View } from 'react-native';
import {
  convertAmount,
  monthlyEquivalent,
  parseMoneyInput,
  spendingPlan,
  toMajor,
  type YearMonth,
} from '@manaclaude/shared';
import { StyleSheet } from 'react-native-unistyles';
import { Card } from '../../design/components/Card';
import { ProgressBar, TextField } from '../../design/components/Controls';
import { IconBadge, SectionHeader } from '../../design/components/Decor';
import { HStack, VStack } from '../../design/components/Layout';
import { ListRow } from '../../design/components/ListRow';
import { Text } from '../../design/components/Text';
import { useLookups, useToday } from '../../data/selectors';
import { useFinance } from '../../data/store';
import { DualAmount } from '../currency/Amount';
import { pickDual, useMoneyDisplay } from '../currency/useMoneyDisplay';
import { updatePlanning, usePlanning } from '../planning/usePlanning';
import { spentByCategory } from './useBudgetData';

/**
 * Spending Plan: expected income minus bills and savings leaves what you can
 * spend. Bills and income come from the recurring list (per-month equivalent);
 * savings is the monthly contribution from the Planning screen.
 */
export function SpendingPlanView({ month }: { month: YearMonth }) {
  const data = useFinance();
  const lookups = useLookups();
  const today = useToday();
  const display = useMoneyDisplay();
  const planning = usePlanning();
  const [savingsText, setSavingsText] = useState(
    String(toMajor(planning.monthlyContribution, planning.currency)),
  );

  const plan = useMemo(
    () =>
      display.dual((cur) =>
        spendingPlan({
          recurring: data.recurring,
          savings:
            convertAmount(planning.monthlyContribution, planning.currency, cur, data.fxRates) ?? 0,
          spentByCategory: spentByCategory(data, lookups.treatment, month, cur, today),
          convert: (amount, from) => convertAmount(amount, from, cur, data.fxRates) ?? 0,
        }),
      ),
    [data, lookups, month, today, display, planning.monthlyContribution, planning.currency],
  );
  const p = plan.main;
  const used = p.leftToSpend > 0 ? p.flexibleSpent / p.leftToSpend : p.flexibleSpent > 0 ? 2 : 0;

  const bills = useMemo(
    () =>
      data.recurring
        .filter((r) => r.status === 'active' && (r.kind === 'bill' || r.kind === 'subscription'))
        .sort((a, b) => Math.abs(monthlyEquivalent(b)) - Math.abs(monthlyEquivalent(a))),
    [data.recurring],
  );

  const commitSavings = () => {
    const parsed = parseMoneyInput(savingsText, planning.currency);
    if (parsed !== null && parsed >= 0) updatePlanning(planning, { monthlyContribution: parsed });
    else setSavingsText(String(toMajor(planning.monthlyContribution, planning.currency)));
  };

  const row = (label: string, sign: '+' | '−' | '=', pick: (v: typeof p) => number, id: string) => (
    <View style={styles.row} key={id} testID={`plan-${id}`}>
      <HStack gap="md">
        <Text variant="title" tone="muted" style={styles.sign}>
          {sign}
        </Text>
        <VStack flex={1}>
          <Text variant={sign === '=' ? 'bodyStrong' : 'body'}>{label}</Text>
        </VStack>
        <DualAmount {...pickDual(display, plan, pick)} size="small" format={{ cents: 'never' }} />
      </HStack>
    </View>
  );

  return (
    <View testID="spending-plan">
      <VStack gap="lg">
        <Card>
          <VStack gap="xs">
            <Text variant="label" tone="muted">
              Left to spend this month
            </Text>
            <DualAmount
              {...pickDual(display, plan, (v) => v.remaining)}
              size="large"
              align="left"
              tone={p.remaining < 0 ? 'danger' : 'default'}
              format={{ cents: 'never' }}
              testID="plan-remaining"
            />
            <Text variant="caption" tone="muted">
              {p.remaining < 0
                ? 'Over the plan by this much'
                : 'After bills, savings and what you already spent'}
            </Text>
            <ProgressBar value={used} accessibilityLabel="Share of spendable money used" />
          </VStack>
        </Card>

        <Card padding="none">
          {row('Expected income', '+', (v) => v.income, 'income')}
          {row('Bills and subscriptions', '−', (v) => v.bills, 'bills')}
          {row('Savings', '−', (v) => v.savings, 'savings')}
          {row('You can spend', '=', (v) => v.leftToSpend, 'left')}
        </Card>

        <Card>
          <VStack gap="sm">
            <TextField
              label={`Savings per month (${planning.currency})`}
              value={savingsText}
              onChangeText={setSavingsText}
              onEndEditing={commitSavings}
              onBlur={commitSavings}
              keyboardType="decimal-pad"
              testID="plan-savings-input"
            />
            <Text variant="caption" tone="muted">
              Also the monthly contribution in your retirement plan.
            </Text>
          </VStack>
        </Card>

        <View>
          <SectionHeader title="Bills in this plan" />
          <Card padding="none">
            {bills.map((r) => {
              const cat = r.categoryId ? lookups.categoriesById.get(r.categoryId) : undefined;
              const perMonth = monthlyEquivalent(r);
              return (
                <ListRow
                  key={r.id}
                  title={r.name}
                  subtitle={
                    r.frequency === 'monthly' ? 'Monthly' : `${r.frequency}, per month shown`
                  }
                  leading={<IconBadge icon={cat?.icon ?? 'repeat'} color={cat?.color ?? 'c1'} />}
                  trailing={
                    <DualAmount
                      {...pickDual(
                        display,
                        display.dual(
                          (cur) => convertAmount(perMonth, r.currency, cur, data.fxRates) ?? 0,
                        ),
                        (v) => v,
                      )}
                      size="small"
                      format={{ cents: 'never' }}
                    />
                  }
                  testID={`plan-bill-${r.id}`}
                />
              );
            })}
          </Card>
        </View>
      </VStack>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.md,
    borderBottomWidth: theme.size.hairline,
    borderColor: theme.colors.border,
  },
  sign: { width: theme.size.iconMd, textAlign: 'center' },
}));
