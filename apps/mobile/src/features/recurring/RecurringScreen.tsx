import { useMemo } from 'react';
import { View } from 'react-native';
import { daysBetween, formatShortDate, type RecurringItem } from '@manaclaude/shared';
import { StyleSheet } from 'react-native-unistyles';
import { Card } from '../../design/components/Card';
import { Badge, type BadgeTone } from '../../design/components/Controls';
import { Banner, IconBadge, SectionHeader } from '../../design/components/Decor';
import { HStack, VStack } from '../../design/components/Layout';
import { ListRow } from '../../design/components/ListRow';
import { MoneyText } from '../../design/components/MoneyText';
import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import { useLookups, useToday } from '../../data/selectors';
import { useFinance } from '../../data/store';
import { Amount } from '../currency/Amount';
import { CurrencyChip } from '../currency/CurrencyChip';
import { useMoneyDisplay } from '../currency/useMoneyDisplay';

const PER_MONTH: Record<RecurringItem['frequency'], number> = {
  weekly: 52 / 12,
  biweekly: 26 / 12,
  monthly: 1,
  quarterly: 1 / 3,
  semiannual: 1 / 6,
  annual: 1 / 12,
};

const DECISION: Record<
  NonNullable<RecurringItem['decision']>,
  { label: string; tone: BadgeTone }
> = {
  keep: { label: 'Keep', tone: 'income' },
  cancel: { label: 'Cancel', tone: 'danger' },
  review: { label: 'Review', tone: 'pending' },
};

/** Latest charge vs the one before, when it went up. */
function priceIncrease(r: RecurringItem): { from: number; to: number } | null {
  const h = r.priceHistory;
  if (h.length < 2) return null;
  const last = h[h.length - 1]!.amount;
  const prev = [...h].reverse().find((p) => p.amount !== last)?.amount;
  if (prev === undefined || Math.abs(last) <= Math.abs(prev)) return null;
  return { from: Math.abs(prev), to: Math.abs(last) };
}

/**
 * Recurring bills, subscriptions and income (session C owns this screen;
 * it adds editing, keep/cancel/review actions and detection from the backend).
 */
export function RecurringScreen() {
  const data = useFinance();
  const lookups = useLookups();
  const today = useToday();
  const display = useMoneyDisplay();
  const currency = display.reportCurrency;

  const { bills, subscriptions, income, monthlyOut, increases } = useMemo(() => {
    const active = data.recurring.filter((r) => r.status === 'active');
    const sortByDue = (a: RecurringItem, b: RecurringItem) =>
      (a.nextDueDate ?? '').localeCompare(b.nextDueDate ?? '');
    const monthlyOut = active
      .filter((r) => r.expectedAmount < 0)
      .reduce(
        (s, r) =>
          s +
          (display.convert(-r.expectedAmount, r.currency, currency) ?? 0) * PER_MONTH[r.frequency],
        0,
      );
    return {
      bills: active.filter((r) => r.kind === 'bill').sort(sortByDue),
      subscriptions: active.filter((r) => r.kind === 'subscription').sort(sortByDue),
      income: active.filter((r) => r.kind === 'income').sort(sortByDue),
      monthlyOut: Math.round(monthlyOut),
      increases: active.map((r) => ({ r, inc: priceIncrease(r) })).filter((x) => x.inc !== null),
    };
  }, [data.recurring, display, currency]);

  const row = (r: RecurringItem) => {
    const cat = r.categoryId ? lookups.categoriesById.get(r.categoryId) : undefined;
    const due = r.nextDueDate ? daysBetween(today, r.nextDueDate) : null;
    const when = r.nextDueDate
      ? due === 0
        ? 'Today'
        : due === 1
          ? 'Tomorrow'
          : formatShortDate(r.nextDueDate)
      : 'Not scheduled';
    return (
      <ListRow
        key={r.id}
        title={r.name}
        subtitle={`${when} · ${r.frequency}${r.isVariable ? ' · varies' : ''}`}
        leading={<IconBadge icon={cat?.icon ?? 'repeat'} color={cat?.color ?? 'c1'} />}
        trailing={
          <VStack align="flex-end" gap="xxs">
            <Amount amount={r.expectedAmount} currency={r.currency} colorize="flow" />
            {r.decision ? (
              <Badge label={DECISION[r.decision].label} tone={DECISION[r.decision].tone} />
            ) : null}
          </VStack>
        }
        testID={`recurring-${r.id}`}
      />
    );
  };

  return (
    <Screen title="Recurring" actions={<CurrencyChip />} testID="screen-recurring">
      <Card>
        <VStack gap="xs">
          <Text variant="label" tone="muted">
            Bills and subscriptions per month
          </Text>
          <MoneyText
            amount={monthlyOut}
            currency={currency}
            size="large"
            format={{ cents: 'never' }}
          />
          <Text variant="caption" tone="muted">
            {`${bills.length} bills · ${subscriptions.length} subscriptions`}
          </Text>
        </VStack>
      </Card>
      {increases.map(({ r, inc }) =>
        inc ? (
          <Banner key={r.id} tone="pending" icon="trending-up">
            <Text variant="bodyStrong">{`${r.name} went up`}</Text>
            <HStack gap="xs">
              <MoneyText amount={inc.from} currency={r.currency} size="small" tone="muted" />
              <Text variant="caption" tone="muted">
                to
              </Text>
              <MoneyText amount={inc.to} currency={r.currency} size="small" />
            </HStack>
          </Banner>
        ) : null,
      )}
      <View>
        <SectionHeader title="Subscriptions" />
        <Card padding="none">{subscriptions.map(row)}</Card>
      </View>
      <View>
        <SectionHeader title="Bills" />
        <Card padding="none">{bills.map(row)}</Card>
      </View>
      <View style={styles.last}>
        <SectionHeader title="Income" />
        <Card padding="none">{income.map(row)}</Card>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create((theme) => ({
  last: { paddingBottom: theme.space.lg },
}));
