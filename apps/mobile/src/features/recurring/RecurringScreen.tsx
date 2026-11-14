import { useMemo, useState } from 'react';
import { View } from 'react-native';
import {
  PER_MONTH,
  convertAmount,
  daysBetween,
  formatShortDate,
  monthlyEquivalent,
  priceIncrease,
  upcomingCharges,
  type RecurringItem,
  type SubscriptionDecision,
} from '@manaclaude/shared';
import { StyleSheet } from 'react-native-unistyles';
import { BottomSheet } from '../../design/components/BottomSheet';
import { Button } from '../../design/components/Button';
import { Card } from '../../design/components/Card';
import { Badge, SegmentedControl, type BadgeTone } from '../../design/components/Controls';
import { Banner, EmptyState, IconBadge, SectionHeader } from '../../design/components/Decor';
import { HStack, VStack } from '../../design/components/Layout';
import { ListRow } from '../../design/components/ListRow';
import { MoneyText } from '../../design/components/MoneyText';
import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import { haptic } from '../../design/haptics';
import { useLookups, useToday } from '../../data/selectors';
import { useFinance } from '../../data/store';
import { Amount, DualAmount } from '../currency/Amount';
import { CurrencyChip } from '../currency/CurrencyChip';
import { skippedItemsText } from '../currency/missingRates';
import { pickDual, useMoneyDisplay } from '../currency/useMoneyDisplay';
import { setDecision, setRecurringStatus } from './actions';

const DECISION: Record<SubscriptionDecision, { label: string; tone: BadgeTone }> = {
  keep: { label: 'Keep', tone: 'income' },
  cancel: { label: 'Cancel', tone: 'danger' },
  review: { label: 'Review', tone: 'pending' },
};

const UPCOMING_DAYS = 30;

function whenLabel(date: string | null, today: string): string {
  if (!date) return 'Not scheduled';
  const due = daysBetween(today, date);
  if (due === 0) return 'Today';
  if (due === 1) return 'Tomorrow';
  return formatShortDate(date, today);
}

/**
 * Recurring bills, subscriptions and income (session C): upcoming charges,
 * keep / cancel / review decisions and price-increase alerts.
 */
export function RecurringScreen() {
  const data = useFinance();
  const lookups = useLookups();
  const today = useToday();
  const display = useMoneyDisplay();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = data.recurring.find((r) => r.id === selectedId) ?? null;

  const m = useMemo(() => {
    const active = data.recurring.filter((r) => r.status === 'active');
    const sortByDue = (a: RecurringItem, b: RecurringItem) =>
      (a.nextDueDate ?? '').localeCompare(b.nextDueDate ?? '');
    const monthlyOut = display.dual((cur) =>
      Math.round(
        active
          .filter((r) => r.expectedAmount < 0)
          .reduce(
            (s, r) =>
              s +
              (convertAmount(-r.expectedAmount, r.currency, cur, data.fxRates) ?? 0) *
                PER_MONTH[r.frequency],
            0,
          ),
      ),
    );
    const upcoming = upcomingCharges(active, today, UPCOMING_DAYS).filter(
      (u) => u.item.kind !== 'income',
    );
    const dueTotal = display.dual((cur) =>
      upcoming.reduce(
        (s, u) =>
          s - (convertAmount(u.item.expectedAmount, u.item.currency, cur, data.fxRates) ?? 0),
        0,
      ),
    );
    const noRate = active.filter(
      (r) =>
        r.kind !== 'income' &&
        convertAmount(r.expectedAmount, r.currency, display.reportCurrency, data.fxRates) === null,
    );
    const increases = active
      .map((r) => ({ r, inc: priceIncrease(r) }))
      .filter((x): x is { r: RecurringItem; inc: NonNullable<typeof x.inc> } => x.inc !== null);
    const toReview = active.filter((r) => r.kind === 'subscription' && r.decision === 'review');
    return {
      bills: active.filter((r) => r.kind === 'bill').sort(sortByDue),
      subscriptions: active.filter((r) => r.kind === 'subscription').sort(sortByDue),
      income: active.filter((r) => r.kind === 'income').sort(sortByDue),
      cancelled: data.recurring.filter((r) => r.status === 'cancelled'),
      monthlyOut,
      upcoming,
      dueTotal,
      noRateText: skippedItemsText(noRate, display.reportCurrency),
      increases,
      toReview,
    };
  }, [data.recurring, data.fxRates, display, today]);

  const row = (r: RecurringItem) => {
    const cat = r.categoryId ? lookups.categoriesById.get(r.categoryId) : undefined;
    return (
      <ListRow
        key={r.id}
        title={r.name}
        subtitle={`${whenLabel(r.nextDueDate, today)} · ${r.frequency}${r.isVariable ? ' · varies' : ''}`}
        leading={<IconBadge icon={cat?.icon ?? 'repeat'} color={cat?.color ?? 'c1'} />}
        onPress={() => setSelectedId(r.id)}
        showChevron
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

  const selectedInc = selected ? priceIncrease(selected) : null;

  return (
    <Screen title="Recurring" actions={<CurrencyChip />} testID="screen-recurring">
      <Card>
        <VStack gap="xs">
          <Text variant="label" tone="muted">
            Bills and subscriptions per month
          </Text>
          <DualAmount
            {...pickDual(display, m.monthlyOut, (v) => v)}
            size="large"
            align="left"
            format={{ cents: 'never' }}
            testID="recurring-monthly"
          />
          <Text variant="caption" tone="muted">
            {`${m.bills.length} bills · ${m.subscriptions.length} subscriptions`}
          </Text>
          {m.noRateText ? (
            <Text variant="caption" tone="muted" testID="recurring-no-rate">
              {m.noRateText}
            </Text>
          ) : null}
        </VStack>
      </Card>

      {m.increases.map(({ r, inc }) => (
        <Banner key={r.id} tone="pending" icon="trending-up">
          <Text
            variant="bodyStrong"
            testID={`increase-${r.id}`}
          >{`${r.name} went up ${Math.round(inc.pct * 100)}%`}</Text>
          <HStack gap="xs" wrap>
            <MoneyText amount={inc.from} currency={r.currency} size="small" tone="muted" />
            <Text variant="caption" tone="muted">
              to
            </Text>
            <MoneyText amount={inc.to} currency={r.currency} size="small" />
            <Text variant="caption" tone="muted">
              since {formatShortDate(inc.since, today)}, about
            </Text>
            <MoneyText amount={inc.yearlyImpact} currency={r.currency} size="small" />
            <Text variant="caption" tone="muted">
              more a year
            </Text>
          </HStack>
        </Banner>
      ))}

      {m.toReview.length > 0 ? (
        <Banner tone="accent" icon="info">
          <Text variant="bodyStrong">{`${m.toReview.length} subscription${m.toReview.length === 1 ? '' : 's'} to review`}</Text>
          <Text variant="caption" tone="muted">
            {m.toReview.map((r) => r.name).join(', ')}
          </Text>
        </Banner>
      ) : null}

      <View>
        <SectionHeader
          title={`Next ${UPCOMING_DAYS} days`}
          trailing={
            <DualAmount
              {...pickDual(display, m.dueTotal, (v) => v)}
              size="small"
              format={{ cents: 'never' }}
              testID="recurring-due-total"
            />
          }
        />
        {m.upcoming.length === 0 ? (
          <EmptyState
            icon="calendar"
            title="Nothing due"
            message="No bills or subscriptions in this window."
          />
        ) : (
          <Card padding="none">
            {m.upcoming.map(({ item, date }) => {
              const cat = item.categoryId ? lookups.categoriesById.get(item.categoryId) : undefined;
              return (
                <ListRow
                  key={`${item.id}-${date}`}
                  title={item.name}
                  subtitle={`${whenLabel(date, today)}${item.isVariable ? ' · about' : ''}`}
                  leading={<IconBadge icon={cat?.icon ?? 'repeat'} color={cat?.color ?? 'c1'} />}
                  onPress={() => setSelectedId(item.id)}
                  trailing={<Amount amount={item.expectedAmount} currency={item.currency} />}
                  testID={`upcoming-${item.id}-${date}`}
                />
              );
            })}
          </Card>
        )}
      </View>

      {m.subscriptions.length + m.bills.length + m.income.length === 0 ? (
        <Card>
          <EmptyState
            icon="repeat"
            title="No bills or subscriptions yet"
            message="Your Worker finds them in your transactions every night. Settings, AI, Run AI jobs now looks right away."
            testID="recurring-empty"
          />
        </Card>
      ) : null}
      {m.subscriptions.length > 0 ? (
        <View>
          <SectionHeader title="Subscriptions" />
          <Card padding="none">{m.subscriptions.map(row)}</Card>
        </View>
      ) : null}
      {m.bills.length > 0 ? (
        <View>
          <SectionHeader title="Bills" />
          <Card padding="none">{m.bills.map(row)}</Card>
        </View>
      ) : null}
      {m.income.length > 0 ? (
        <View>
          <SectionHeader title="Income" />
          <Card padding="none">{m.income.map(row)}</Card>
        </View>
      ) : null}
      {m.cancelled.length > 0 ? (
        <View style={styles.last}>
          <SectionHeader title="Cancelled" />
          <Card padding="none">
            {m.cancelled.map((r) => (
              <ListRow
                key={r.id}
                title={r.name}
                subtitle="Cancelled"
                dimmed
                onPress={() => setSelectedId(r.id)}
                trailing={<Amount amount={r.expectedAmount} currency={r.currency} />}
                testID={`recurring-${r.id}`}
              />
            ))}
          </Card>
        </View>
      ) : (
        <View style={styles.last} />
      )}

      <BottomSheet
        visible={selected !== null}
        onClose={() => setSelectedId(null)}
        title={selected?.name ?? ''}
        testID="recurring-sheet"
      >
        {selected ? (
          <VStack gap="md">
            <HStack justify="space-between">
              <VStack gap="xxs">
                <Text variant="label" tone="muted">
                  {selected.isVariable ? 'About' : 'Next charge'}
                </Text>
                <Amount
                  amount={selected.expectedAmount}
                  currency={selected.currency}
                  align="left"
                />
              </VStack>
              <VStack gap="xxs" align="flex-end">
                <Text variant="label" tone="muted">
                  Per month
                </Text>
                <Amount amount={monthlyEquivalent(selected)} currency={selected.currency} />
              </VStack>
            </HStack>
            <Text variant="caption" tone="muted">
              {`${selected.frequency}, next ${whenLabel(selected.nextDueDate, today)}`}
            </Text>
            {selectedInc ? (
              <Banner tone="pending" icon="trending-up">
                <Text variant="caption">
                  {`Up ${Math.round(selectedInc.pct * 100)}% since ${formatShortDate(selectedInc.since, today)}`}
                </Text>
              </Banner>
            ) : null}
            {selected.kind === 'subscription' ? (
              <VStack gap="xs">
                <Text variant="label" tone="muted">
                  Your decision
                </Text>
                <SegmentedControl
                  accessibilityLabel="Decision"
                  value={selected.decision ?? 'review'}
                  onChange={(d) => {
                    setDecision(selected.id, d);
                    haptic('selection');
                  }}
                  options={[
                    { value: 'keep', label: 'Keep' },
                    { value: 'review', label: 'Review' },
                    { value: 'cancel', label: 'Cancel' },
                  ]}
                />
              </VStack>
            ) : null}
            {selected.status === 'cancelled' ? (
              <Button
                label="Mark as active again"
                variant="secondary"
                onPress={() => setRecurringStatus(selected.id, 'active')}
                testID="recurring-reactivate"
              />
            ) : selected.kind === 'subscription' ? (
              <Button
                label="I cancelled it"
                variant="danger"
                onPress={() => {
                  setRecurringStatus(selected.id, 'cancelled');
                  haptic('confirm');
                  setSelectedId(null);
                }}
                testID="recurring-mark-cancelled"
              />
            ) : null}
          </VStack>
        ) : null}
      </BottomSheet>
    </Screen>
  );
}

const styles = StyleSheet.create((theme) => ({
  last: { paddingBottom: theme.space.lg },
}));
