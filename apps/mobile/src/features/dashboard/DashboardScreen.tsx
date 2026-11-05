import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { addDays, formatMonth, formatShortDate, type Transaction } from '@manaclaude/shared';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Card } from '../../design/components/Card';
import { LineChart } from '../../design/components/charts/Charts';
import { Badge, ProgressBar } from '../../design/components/Controls';
import { Banner, IconBadge } from '../../design/components/Decor';
import { HStack, VStack } from '../../design/components/Layout';
import { ListRow } from '../../design/components/ListRow';
import { MoneyText } from '../../design/components/MoneyText';
import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import {
  budgetMonth,
  currentNetWorth,
  monthSpending,
  netWorthHistory,
  upcomingRecurring,
} from '../../data/metrics';
import { useLookups, useToday } from '../../data/selectors';
import { useSettings } from '../../data/settingsStore';
import { useFinance } from '../../data/store';
import { Amount } from '../currency/Amount';
import { CurrencyChip } from '../currency/CurrencyChip';
import { useMoneyDisplay } from '../currency/useMoneyDisplay';
import { CashQuickAddButton } from '../transactions/CashQuickAdd';
import { describeTransaction, isListed } from '../transactions/display';
import { reviewCount } from '../transactions/reviewQueue';
import { TransactionDetailSheet } from '../transactions/TransactionDetailSheet';
import { TransactionRow } from '../transactions/TransactionRow';

/**
 * Dashboard (session A owns this screen). Two layouts behind a setting:
 * a widget grid, or one safe-to-spend number with a spending chart.
 */
export function DashboardScreen() {
  const data = useFinance();
  const lookups = useLookups();
  const today = useToday();
  const display = useMoneyDisplay();
  const { dashboardLayout } = useSettings();
  const { theme } = useUnistyles();
  const [open, setOpen] = useState<Transaction | null>(null);
  const currency = display.reportCurrency;

  const metrics = useMemo(() => {
    const spending = monthSpending(data, lookups.treatment, currency, today);
    const budget = budgetMonth(data, lookups.treatment, spending.month, currency, today);
    const netWorth = currentNetWorth(data, currency);
    const history = netWorthHistory(data, currency);
    const monthAgo = history.find((p) => p.date >= addDays(today, -30));
    const upcoming = upcomingRecurring(data, today, 14);
    const recent = data.transactions.filter((t) => isListed(t, lookups)).slice(0, 6);
    const toReview = reviewCount(data.transactions, lookups);
    const billsLeft = upcomingRecurring(data, today, spending.daysInMonth - spending.dayOfMonth)
      .filter((r) => r.expectedAmount < 0 && r.kind !== 'transfer')
      .reduce((s, r) => s + (display.convert(-r.expectedAmount, r.currency, currency) ?? 0), 0);
    const safeToSpend = budget.totalBudgeted - budget.totalSpent - billsLeft;
    return {
      spending,
      budget,
      netWorth,
      history,
      monthAgo,
      upcoming,
      recent,
      toReview,
      billsLeft,
      safeToSpend,
    };
  }, [data, lookups, currency, today, display]);

  const [scrub, setScrub] = useState<number | null>(null);
  const { spending, netWorth } = metrics;
  const shownDay = scrub ?? spending.cumulative.length - 1;
  const shownSpent = spending.cumulative[shownDay] ?? 0;
  const lastMonthSame = spending.lastMonthCumulative[shownDay] ?? 0;
  const delta = shownSpent - lastMonthSame;
  const daysLeft = spending.daysInMonth - spending.dayOfMonth + 1;

  const spendingCard = (
    <Card>
      <VStack gap="sm">
        <HStack justify="space-between">
          <Text variant="label" tone="muted">
            {scrub === null
              ? `Spent in ${formatMonth(spending.month).split(' ')[0]}`
              : `Spent by ${formatShortDate(addDays(`${spending.month}-01`, shownDay))}`}
          </Text>
          <Badge
            label={`${delta <= 0 ? 'Below' : 'Above'} last month`}
            tone={delta <= 0 ? 'income' : 'spending'}
          />
        </HStack>
        <MoneyText
          amount={shownSpent}
          currency={currency}
          size="large"
          format={{ cents: 'auto' }}
        />
        <Text variant="caption" tone="muted">
          <MoneyText
            amount={Math.abs(delta)}
            currency={currency}
            size="small"
            tone="muted"
            format={{ cents: 'never' }}
          />
          {delta <= 0 ? ' less than' : ' more than'} the same point last month
        </Text>
        <LineChart
          values={spending.cumulative}
          compare={spending.lastMonthCumulative}
          slots={Math.max(spending.daysInMonth, spending.lastMonthCumulative.length)}
          role="spending"
          onScrub={setScrub}
          accessibilityLabel="Cumulative spending this month compared with last month"
          testID="spending-chart"
        />
        <HStack gap="lg">
          <HStack gap="xs">
            <View style={styles.legend(theme.colors.spending)} />
            <Text variant="caption" tone="muted">
              This month
            </Text>
          </HStack>
          <HStack gap="xs">
            <View style={styles.legend(theme.colors.chartComparison)} />
            <Text variant="caption" tone="muted">
              Last month
            </Text>
          </HStack>
        </HStack>
      </VStack>
    </Card>
  );

  if (dashboardLayout === 'safe_to_spend') {
    return (
      <Screen
        title="Home"
        subtitle={formatMonth(spending.month)}
        actions={<CurrencyChip />}
        overlay={<CashQuickAddButton />}
        testID="screen-dashboard"
      >
        <Card>
          <VStack gap="xs" align="center">
            <Text variant="label" tone="muted">
              Safe to spend this month
            </Text>
            <Amount
              amount={metrics.safeToSpend}
              currency={currency}
              size="hero"
              align="center"
              format={{ cents: 'never' }}
              tone={metrics.safeToSpend < 0 ? 'danger' : 'default'}
            />
            <Text variant="caption" tone="muted" align="center">
              Budget left after bills still due. About{' '}
              <MoneyText
                amount={Math.round(Math.max(0, metrics.safeToSpend) / daysLeft)}
                currency={currency}
                size="small"
                tone="muted"
                format={{ cents: 'never' }}
              />{' '}
              a day for {daysLeft} days.
            </Text>
          </VStack>
        </Card>
        <View style={styles.statRow}>
          <Card style={styles.stat}>
            <VStack gap="xxs">
              <Text variant="label" tone="muted">
                Bills still due
              </Text>
              <Amount
                amount={metrics.billsLeft}
                currency={currency}
                align="left"
                format={{ cents: 'never' }}
                testID="bills-left"
              />
            </VStack>
          </Card>
          <Card
            style={styles.stat}
            onPress={() => router.navigate('/transactions/review')}
            accessibilityLabel="Transactions to review"
          >
            <VStack gap="xxs">
              <Text variant="label" tone="muted">
                To review
              </Text>
              <Text variant="amount" numeric>
                {metrics.toReview}
              </Text>
            </VStack>
          </Card>
        </View>
        {spendingCard}
      </Screen>
    );
  }

  const budgetUsed = metrics.budget.totalBudgeted
    ? metrics.budget.totalSpent / metrics.budget.totalBudgeted
    : 0;
  const nwChange = metrics.monthAgo ? netWorth.netWorth - metrics.monthAgo.value : 0;

  return (
    <Screen
      title="Home"
      subtitle={formatMonth(spending.month)}
      actions={<CurrencyChip />}
      overlay={<CashQuickAddButton />}
      testID="screen-dashboard"
    >
      <Banner icon="info">
        <Text variant="caption" tone="muted">
          Sample data. Your accounts appear here once connectors are set up.
        </Text>
      </Banner>
      <View style={styles.grid}>
        <View style={styles.col}>
          <Card onPress={() => router.navigate('/networth')} accessibilityLabel="Net worth">
            <VStack gap="xs">
              <Text variant="label" tone="muted">
                Net worth
              </Text>
              <Amount
                amount={netWorth.netWorth}
                currency={currency}
                size="hero"
                align="left"
                format={{ cents: 'never' }}
                testID="net-worth"
              />
              <HStack gap="xs">
                <MoneyText
                  amount={nwChange}
                  currency={currency}
                  size="small"
                  colorize="signed"
                  format={{ cents: 'never', sign: 'always' }}
                />
                <Text variant="caption" tone="muted">
                  in 30 days
                </Text>
              </HStack>
              <LineChart
                values={metrics.history.map((p) => p.value)}
                role="netWorth"
                height="small"
                accessibilityLabel="Net worth over the last year"
              />
            </VStack>
          </Card>
          {spendingCard}
        </View>
        <View style={styles.col}>
          <Card onPress={() => router.navigate('/budgets')} accessibilityLabel="Budget">
            <VStack gap="sm">
              <HStack justify="space-between">
                <Text variant="label" tone="muted">
                  Budget
                </Text>
                <Text variant="caption" tone="muted">{`${daysLeft} days left`}</Text>
              </HStack>
              <HStack gap="xs" align="baseline">
                <MoneyText
                  amount={metrics.budget.totalSpent}
                  currency={currency}
                  size="large"
                  format={{ cents: 'never' }}
                />
                <Text variant="body" tone="muted">
                  of{' '}
                  <MoneyText
                    amount={metrics.budget.totalBudgeted}
                    currency={currency}
                    size="medium"
                    tone="muted"
                    format={{ cents: 'never' }}
                  />
                </Text>
              </HStack>
              <ProgressBar
                value={budgetUsed}
                marker={spending.dayOfMonth / spending.daysInMonth}
                accessibilityLabel="Budget used"
              />
            </VStack>
          </Card>
          <Card
            padding="none"
            onPress={() => router.navigate('/transactions/review')}
            accessibilityLabel="Transactions to review"
          >
            <ListRow
              title={`${metrics.toReview} transactions to review`}
              subtitle="Check categories the AI wasn't sure about"
              leading={<IconBadge icon="sparkles" color="c4" />}
              showChevron
            />
          </Card>
          <Card padding="none">
            <View style={styles.cardHeader}>
              <Text variant="label" tone="muted">
                Coming up
              </Text>
            </View>
            {metrics.upcoming.slice(0, 4).map((r) => {
              const cat = r.categoryId ? lookups.categoriesById.get(r.categoryId) : undefined;
              return (
                <ListRow
                  key={r.id}
                  title={r.name}
                  subtitle={r.nextDueDate ? formatShortDate(r.nextDueDate) : ''}
                  leading={
                    <IconBadge icon={cat?.icon ?? 'repeat'} color={cat?.color ?? 'c1'} size="sm" />
                  }
                  trailing={
                    <Amount
                      amount={r.expectedAmount}
                      currency={r.currency}
                      colorize="flow"
                      size="small"
                    />
                  }
                />
              );
            })}
          </Card>
          <Card padding="none">
            <View style={styles.cardHeader}>
              <Text variant="label" tone="muted">
                Recent
              </Text>
              <Text variant="label" tone="accent" onPress={() => router.navigate('/transactions')}>
                See all
              </Text>
            </View>
            {metrics.recent.map((t) => (
              <TransactionRow
                key={t.id}
                row={describeTransaction(t, lookups)}
                lookups={lookups}
                onPress={() => setOpen(t)}
              />
            ))}
          </Card>
        </View>
      </View>
      <TransactionDetailSheet txn={open} lookups={lookups} onClose={() => setOpen(null)} />
    </Screen>
  );
}

const styles = StyleSheet.create((theme) => ({
  grid: {
    flexDirection: { xs: 'column', md: 'row' },
    gap: theme.space.md,
    alignItems: 'flex-start',
  },
  statRow: { flexDirection: 'row', gap: theme.space.md },
  stat: { flex: 1 },
  col: { flex: { xs: undefined, md: 1 }, gap: theme.space.md, width: '100%' },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: theme.space.lg,
    paddingTop: theme.space.md,
    paddingBottom: theme.space.xs,
  },
  legend: (color: string) => ({
    width: theme.space.md,
    height: theme.size.focusRing,
    borderRadius: theme.radius.pill,
    backgroundColor: color,
  }),
}));
