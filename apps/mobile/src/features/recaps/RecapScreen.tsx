import { useMemo, useState } from 'react';
import { View } from 'react-native';
import {
  addDays,
  addMonthsToMonth,
  buildRecap,
  formatMonth,
  formatShortDate,
  monthOf,
  monthlyPeriod,
  weeklyPeriod,
  type Recap,
} from '@manaclaude/shared';
import { Card } from '../../design/components/Card';
import { BarChart } from '../../design/components/charts/Charts';
import { Chip, ProgressBar, SegmentedControl } from '../../design/components/Controls';
import { Banner, IconBadge, SectionHeader } from '../../design/components/Decor';
import { HStack, VStack } from '../../design/components/Layout';
import { ListRow } from '../../design/components/ListRow';
import { MoneyText } from '../../design/components/MoneyText';
import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import { useLookups, useToday } from '../../data/selectors';
import { useFinance } from '../../data/store';
import { DualAmount } from '../currency/Amount';
import { CurrencyChip } from '../currency/CurrencyChip';
import { pickDual, useMoneyDisplay } from '../currency/useMoneyDisplay';
import { BackAction } from '../planning/BackAction';
import { goReplace } from '../planning/navigate';

export interface RecapScreenProps {
  kind: Recap['kind'];
}

/**
 * Weekly recap and Month in Review (session C). Text and numbers come from the
 * backend's recap job when it has stored one for the period in this currency;
 * otherwise they are built on the device from the transactions.
 */
export function RecapScreen({ kind }: RecapScreenProps) {
  const data = useFinance();
  const lookups = useLookups();
  const today = useToday();
  const display = useMoneyDisplay();
  const currency = display.reportCurrency;
  const [back, setBack] = useState(0);

  const period = useMemo(
    () =>
      kind === 'weekly'
        ? weeklyPeriod(addDays(today, -7 * back))
        : monthlyPeriod(addMonthsToMonth(monthOf(today), -back), today),
    [kind, back, today],
  );

  const recap = useMemo(
    () =>
      display.dual((cur) => {
        const stored = (data.recaps ?? []).find(
          (r) => r.kind === kind && r.periodStart === period.start && r.currency === cur,
        );
        return stored ?? buildRecap(data, { period, currency: cur, ctx: lookups.treatment });
      }),
    [data, display, kind, period, lookups],
  );
  const r = recap.main;

  const diff = r.spending - r.previousSpending;
  const vs = kind === 'weekly' ? 'the week before' : 'the month before';
  const label =
    kind === 'weekly'
      ? `${formatShortDate(r.periodStart, today)} to ${formatShortDate(r.periodEnd, today)}`
      : formatMonth(r.periodStart.slice(0, 7));
  const maxCat = Math.max(1, ...r.topCategories.map((c) => c.amount));
  const choices = kind === 'weekly' ? [0, 1, 2, 3] : [0, 1, 2, 3];
  const chipLabel = (i: number) =>
    kind === 'weekly'
      ? i === 0
        ? 'Last 7 days'
        : i === 1
          ? 'Week before'
          : `${i} weeks back`
      : formatMonth(addMonthsToMonth(monthOf(today), -i));

  return (
    <Screen
      title={kind === 'weekly' ? 'Weekly recap' : 'Month in review'}
      subtitle={label}
      actions={
        <HStack gap="xs">
          <BackAction fallback="/budgets" />
          <CurrencyChip />
        </HStack>
      }
      testID={`screen-recap-${kind}`}
    >
      <SegmentedControl
        accessibilityLabel="Recap type"
        value={kind}
        onChange={(k) => goReplace(k === 'weekly' ? '/recaps/weekly' : '/recaps/month')}
        options={[
          { value: 'weekly', label: 'Weekly' },
          { value: 'monthly', label: 'Month' },
        ]}
      />
      <HStack gap="xs" wrap>
        {choices.map((i) => (
          <Chip key={i} label={chipLabel(i)} selected={back === i} onPress={() => setBack(i)} />
        ))}
      </HStack>

      <Card>
        <VStack gap="sm">
          <Text variant="headline" testID="recap-headline">
            {r.headline}
          </Text>
          <Text variant="label" tone="muted">
            Spent
          </Text>
          <DualAmount
            {...pickDual(display, recap, (x) => x.spending)}
            size="hero"
            align="left"
            format={{ cents: 'never' }}
            testID="recap-spending"
          />
          <HStack gap="xs" wrap>
            <MoneyText
              amount={Math.abs(diff)}
              currency={currency}
              size="small"
              tone={diff > 0 ? 'spending' : 'income'}
              format={{ cents: 'never' }}
            />
            <Text variant="caption" tone="muted">
              {`${diff > 0 ? 'more' : 'less'} than ${vs}`}
            </Text>
          </HStack>
          <BarChart
            data={[
              { label: kind === 'weekly' ? 'Before' : 'Previous', value: r.previousSpending },
              { label: kind === 'weekly' ? 'This week' : 'This month', value: r.spending },
            ]}
            highlightIndex={1}
            accessibilityLabel="Spending against the period before"
          />
        </VStack>
      </Card>

      <HStack gap="md">
        <Card style={{ flex: 1 }}>
          <VStack gap="xxs">
            <Text variant="label" tone="muted">
              Income
            </Text>
            <DualAmount
              {...pickDual(display, recap, (x) => x.income)}
              align="left"
              colorize="flow"
              format={{ cents: 'never' }}
            />
          </VStack>
        </Card>
        <Card style={{ flex: 1 }}>
          <VStack gap="xxs">
            <Text variant="label" tone="muted">
              Net worth
            </Text>
            {r.netWorthChange === null ? (
              <Text variant="body" tone="muted">
                Not enough history
              </Text>
            ) : (
              <DualAmount
                {...pickDual(display, recap, (x) => x.netWorthChange ?? 0)}
                align="left"
                colorize="signed"
                format={{ cents: 'never', sign: 'always' }}
              />
            )}
          </VStack>
        </Card>
      </HStack>

      {r.highlights.length > 0 ? (
        <Banner tone="accent" icon="info">
          <VStack gap="xs">
            {r.highlights.map((h) => (
              <Text key={h} variant="body">
                {h}
              </Text>
            ))}
          </VStack>
        </Banner>
      ) : null}

      <View>
        <SectionHeader title="Top categories" />
        <Card padding="none">
          {r.topCategories.map((c) => {
            const cat = lookups.categoriesById.get(c.categoryId);
            const delta = c.amount - c.previous;
            return (
              <ListRow
                key={c.categoryId}
                title={cat?.name ?? 'Uncategorized'}
                subtitle={
                  c.previous > 0
                    ? `${delta >= 0 ? 'Up' : 'Down'} ${Math.round((Math.abs(delta) / c.previous) * 100)}% from ${vs}`
                    : 'New this period'
                }
                leading={<IconBadge icon={cat?.icon ?? 'circle'} color={cat?.color ?? 'c1'} />}
                trailing={
                  <VStack align="flex-end" gap="xs">
                    <MoneyText amount={c.amount} currency={currency} format={{ cents: 'never' }} />
                    <ProgressBar
                      value={c.amount / maxCat}
                      accessibilityLabel={`${cat?.name} share`}
                    />
                  </VStack>
                }
                testID={`recap-cat-${c.categoryId}`}
              />
            );
          })}
        </Card>
      </View>

      {r.biggestTransactions.length > 0 ? (
        <View>
          <SectionHeader title="Biggest purchases" />
          <Card padding="none">
            {r.biggestTransactions.map((b) => {
              const t = lookups.transactionsById.get(b.transactionId);
              const cat = t?.categoryId ? lookups.categoriesById.get(t.categoryId) : undefined;
              return (
                <ListRow
                  key={b.transactionId}
                  title={t?.name ?? 'Purchase'}
                  subtitle={t ? formatShortDate(t.date, today) : undefined}
                  leading={<IconBadge icon={cat?.icon ?? 'circle'} color={cat?.color ?? 'c1'} />}
                  trailing={<MoneyText amount={b.amount} currency={currency} />}
                  testID={`recap-txn-${b.transactionId}`}
                />
              );
            })}
          </Card>
        </View>
      ) : null}
      <Text variant="caption" tone="faint" align="center">
        {r.source === 'ai'
          ? 'Written by your AI recap job.'
          : 'Built on this device from your transactions.'}
      </Text>
    </Screen>
  );
}
