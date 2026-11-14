import { useMemo, useState } from 'react';
import { View } from 'react-native';
import {
  classifyAccountType,
  convertAmount,
  formatShortDate,
  monthOf,
  parseMoneyInput,
  projectFire,
  toMajor,
  type Goal,
  type PlanningAssumptions,
} from '@manaclaude/shared';
import { StyleSheet } from 'react-native-unistyles';
import { Card } from '../../design/components/Card';
import { LineChart } from '../../design/components/charts/Charts';
import { Badge, ProgressBar, SegmentedControl, TextField } from '../../design/components/Controls';
import { Banner, IconBadge, SectionHeader } from '../../design/components/Decor';
import { HStack, VStack } from '../../design/components/Layout';
import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import { accountsWithoutRate, countsInNetWorth } from '../../data/metrics';
import { useToday } from '../../data/selectors';
import { useFinance } from '../../data/store';
import { Amount } from '../currency/Amount';
import { CurrencyChip } from '../currency/CurrencyChip';
import { useMoneyDisplay } from '../currency/useMoneyDisplay';
import { noRateText } from '../networth/leftOut';
import { BackAction } from './BackAction';
import { goalStatus, leftOutText } from './goalStatus';
import { updatePlanning, usePlanning } from './usePlanning';

type Field =
  | { key: 'currentAge' | 'retirementAge'; label: string; kind: 'int' }
  | { key: 'annualReturn' | 'inflation' | 'withdrawalRate'; label: string; kind: 'percent' }
  | { key: 'monthlyContribution' | 'annualExpenses'; label: string; kind: 'money' };

const FIELDS: Field[] = [
  { key: 'currentAge', label: 'Your age', kind: 'int' },
  { key: 'retirementAge', label: 'Retire at age', kind: 'int' },
  { key: 'annualReturn', label: 'Yearly return (%)', kind: 'percent' },
  { key: 'inflation', label: 'Inflation (%)', kind: 'percent' },
  { key: 'monthlyContribution', label: 'Saved each month', kind: 'money' },
  { key: 'annualExpenses', label: 'Yearly spending in retirement', kind: 'money' },
  { key: 'withdrawalRate', label: 'Withdrawal rate (%)', kind: 'percent' },
];

function show(field: Field, p: PlanningAssumptions): string {
  const v = p[field.key];
  if (field.kind === 'percent') return String(Math.round(v * 10_000) / 100);
  if (field.kind === 'money') return String(toMajor(v, p.currency));
  return String(v);
}

/** One number the user can type. Commits when editing ends; bad input snaps back. */
function AssumptionField({ field, planning }: { field: Field; planning: PlanningAssumptions }) {
  const [text, setText] = useState(show(field, planning));
  const commit = () => {
    const n = Number(text);
    if (field.kind === 'money') {
      const parsed = parseMoneyInput(text, planning.currency);
      if (parsed !== null && parsed >= 0) return updatePlanning(planning, { [field.key]: parsed });
    } else if (Number.isFinite(n) && n >= 0 && text.trim() !== '') {
      if (field.kind === 'percent' && n <= 100)
        return updatePlanning(planning, { [field.key]: n / 100 });
      if (field.kind === 'int' && n <= 110 && Number.isInteger(n))
        return updatePlanning(planning, { [field.key]: n });
    }
    setText(show(field, planning));
  };
  return (
    <View style={styles.field}>
      <TextField
        label={field.label}
        value={text}
        onChangeText={setText}
        onEndEditing={commit}
        onBlur={commit}
        keyboardType="decimal-pad"
        testID={`plan-field-${field.key}`}
      />
    </View>
  );
}

function goalIcon(goal: Goal) {
  return goal.kind === 'debt_payoff'
    ? 'credit-card'
    : goal.kind === 'purchase'
      ? 'home'
      : 'piggy-bank';
}

function GoalRow({ goal }: { goal: Goal }) {
  const data = useFinance();
  const today = useToday();
  const { progress, leftOut } = useMemo(
    () => goalStatus(goal, data.accounts, data.fxRates, monthOf(today)),
    [data.accounts, data.fxRates, goal, today],
  );
  const note = leftOutText(goal, leftOut);
  if (!progress)
    return (
      <View style={styles.goal} testID={`goal-${goal.id}`}>
        <HStack gap="md">
          <IconBadge icon={goalIcon(goal)} color={goal.color} size="sm" />
          <VStack flex={1} gap="xxs">
            <Text variant="bodyStrong" numberOfLines={1}>
              {goal.name}
            </Text>
            <Text variant="caption" tone="muted">
              {goal.targetDate ? `By ${formatShortDate(goal.targetDate, today)}` : 'No date'}
            </Text>
          </VStack>
          <VStack align="flex-end" gap="xxs">
            <Text variant="bodyStrong" testID={`goal-unknown-${goal.id}`}>
              Unknown
            </Text>
            <Text variant="caption" tone="muted">
              of
            </Text>
            <Amount
              amount={goal.targetAmount}
              currency={goal.currency}
              size="small"
              tone="muted"
              format={{ cents: 'never' }}
            />
          </VStack>
        </HStack>
        <Text variant="caption" tone="muted" testID={`goal-left-out-${goal.id}`}>
          {`Progress is not known. ${note ?? ''}`.trim()}
        </Text>
      </View>
    );
  return (
    <View style={styles.goal} testID={`goal-${goal.id}`}>
      <HStack gap="md">
        <IconBadge icon={goalIcon(goal)} color={goal.color} size="sm" />
        <VStack flex={1} gap="xxs">
          <Text variant="bodyStrong" numberOfLines={1}>
            {goal.name}
          </Text>
          <Text variant="caption" tone="muted">
            {goal.targetDate ? `By ${formatShortDate(goal.targetDate, today)}` : 'No date'}
            {progress.monthlyNeeded !== null ? ' · needs ' : ''}
          </Text>
          {progress.monthlyNeeded !== null ? (
            <Amount
              amount={progress.monthlyNeeded}
              currency={goal.currency}
              size="small"
              align="left"
              tone="muted"
              format={{ cents: 'never' }}
            />
          ) : null}
        </VStack>
        <VStack align="flex-end" gap="xxs">
          <Amount
            amount={progress.current}
            currency={goal.currency}
            size="small"
            format={{ cents: 'never' }}
          />
          <Text variant="caption" tone="muted">
            of
          </Text>
          <Amount
            amount={progress.target}
            currency={goal.currency}
            size="small"
            tone="muted"
            format={{ cents: 'never' }}
          />
        </VStack>
      </HStack>
      <ProgressBar value={progress.fraction} accessibilityLabel={`${goal.name} progress`} />
      <HStack justify="space-between">
        <Text
          variant="caption"
          tone="muted"
          numeric
        >{`${Math.round(progress.fraction * 100)}%`}</Text>
        {progress.fraction >= 1 ? <Badge label="Reached" tone="income" /> : null}
      </HStack>
      {note ? (
        <Text variant="caption" tone="muted" testID={`goal-left-out-${goal.id}`}>
          {note}
        </Text>
      ) : null}
    </View>
  );
}

/** Retirement / FIRE projection and goals (session C). */
export function PlanningScreen() {
  const data = useFinance();
  const display = useMoneyDisplay();
  const planning = usePlanning();
  const [basis, setBasis] = useState<'real' | 'nominal'>('real');
  const currency = display.reportCurrency;

  const { startingSavings, savingsNoRate } = useMemo(() => {
    const investments = data.accounts.filter(
      (a) =>
        countsInNetWorth(a) &&
        classifyAccountType(a.type) === 'asset' &&
        (a.type === 'brokerage' || a.type === 'retirement' || a.type === 'crypto'),
    );
    const noRate = accountsWithoutRate(investments, planning.currency, data.fxRates);
    return {
      startingSavings: investments.reduce(
        (s, a) => s + (convertAmount(a.balance, a.currency, planning.currency, data.fxRates) ?? 0),
        0,
      ),
      savingsNoRate: noRate,
    };
  }, [data.accounts, data.fxRates, planning.currency]);

  const result = useMemo(
    () =>
      projectFire({
        currentSavings: startingSavings,
        monthlyContribution: planning.monthlyContribution,
        annualReturn: planning.annualReturn,
        inflation: planning.inflation,
        currentAge: planning.currentAge,
        retirementAge: planning.retirementAge,
        annualExpenses: planning.annualExpenses,
        withdrawalRate: planning.withdrawalRate,
      }),
    [startingSavings, planning],
  );

  const toChart = (amount: number) =>
    toMajor(display.convert(amount, planning.currency, currency) ?? 0, currency);
  const series = result.points.map((p) => toChart(basis === 'real' ? p.real : p.nominal));
  const targetLine = result.points.map((p) =>
    toChart(basis === 'real' ? result.target : result.target * (1 + planning.inflation) ** p.year),
  );
  const first = result.points[0];
  const last = result.points[result.points.length - 1];

  return (
    <Screen
      title="Planning"
      subtitle="Retirement and goals"
      actions={
        <HStack gap="xs">
          <BackAction fallback="/budgets" />
          <CurrencyChip />
        </HStack>
      }
      testID="screen-planning"
    >
      {result.onTrack ? (
        <Banner tone="accent" icon="trending-up">
          <Text variant="bodyStrong" testID="fire-status">
            {`On track: you reach your target at age ${Math.ceil(result.fireAge ?? planning.retirementAge)}`}
          </Text>
          <Text variant="caption" tone="muted">
            That is by your retirement age of {planning.retirementAge}.
          </Text>
        </Banner>
      ) : (
        <Banner tone="pending" icon="info">
          <Text variant="bodyStrong" testID="fire-status">
            {result.fireAge === null
              ? 'The target is out of reach with these numbers'
              : `Off track: you reach your target at age ${Math.ceil(result.fireAge)}`}
          </Text>
          <HStack gap="xs" wrap>
            <Text variant="caption" tone="muted">
              To retire at {planning.retirementAge}, save about
            </Text>
            <Amount
              amount={result.requiredMonthlyContribution}
              currency={planning.currency}
              size="small"
              format={{ cents: 'never' }}
            />
            <Text variant="caption" tone="muted">
              a month.
            </Text>
          </HStack>
        </Banner>
      )}

      <Card>
        <VStack gap="sm">
          <HStack justify="space-between" align="flex-start">
            <VStack gap="xxs">
              <Text variant="label" tone="muted">
                Target (4% rule)
              </Text>
              <Amount
                amount={result.target}
                currency={planning.currency}
                size="large"
                align="left"
                format={{ cents: 'never' }}
                testID="fire-target"
              />
            </VStack>
            <VStack gap="xxs" align="flex-end">
              <Text variant="label" tone="muted">
                At retirement
              </Text>
              <Amount
                amount={result.balanceAtRetirement}
                currency={planning.currency}
                format={{ cents: 'never' }}
                testID="fire-at-retirement"
              />
            </VStack>
          </HStack>
          <LineChart
            values={series}
            compare={targetLine}
            role="netWorth"
            area
            accessibilityLabel="Projected savings against the target"
            testID="fire-chart"
          />
          <HStack justify="space-between">
            <Text variant="caption" tone="muted">{`Age ${first?.age ?? ''}`}</Text>
            <Text variant="caption" tone="muted">{`Age ${last?.age ?? ''}`}</Text>
          </HStack>
          <SegmentedControl
            accessibilityLabel="Money basis"
            value={basis}
            onChange={setBasis}
            options={[
              { value: 'real', label: "Today's money" },
              { value: 'nominal', label: 'Future dollars' },
            ]}
          />
          <HStack justify="space-between">
            <Text variant="body" tone="muted">
              Starting from investment accounts
            </Text>
            <Amount
              amount={startingSavings}
              currency={planning.currency}
              size="small"
              format={{ cents: 'never' }}
            />
          </HStack>
          {savingsNoRate.length > 0 ? (
            <Text variant="caption" tone="muted" testID="plan-no-rate">
              {noRateText(savingsNoRate, planning.currency)}
            </Text>
          ) : null}
          <HStack justify="space-between">
            <Text variant="body" tone="muted">
              Income it supports each year
            </Text>
            <Amount
              amount={result.sustainableIncome}
              currency={planning.currency}
              size="small"
              format={{ cents: 'never' }}
            />
          </HStack>
        </VStack>
      </Card>

      <View>
        <SectionHeader title="Assumptions" />
        <Card>
          <View style={styles.fields}>
            {FIELDS.map((f) => (
              <AssumptionField key={`${f.key}`} field={f} planning={planning} />
            ))}
          </View>
        </Card>
      </View>

      <View style={styles.last}>
        <SectionHeader title="Goals" />
        <Card padding="none">
          {data.goals.map((g) => (
            <GoalRow key={g.id} goal={g} />
          ))}
        </Card>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create((theme) => ({
  fields: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.md },
  field: { flexGrow: 1, flexBasis: { xs: '100%', sm: '45%' } },
  goal: {
    gap: theme.space.sm,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.md,
    borderBottomWidth: theme.size.hairline,
    borderColor: theme.colors.border,
  },
  last: { paddingBottom: theme.space.lg },
}));
