import { useMemo, useState } from 'react';
import { View } from 'react-native';
import {
  addMonths,
  classifyAccountType,
  decToNumber,
  formatShortDate,
  lotPerformance,
  type AccountType,
  type Holding,
  type Security,
} from '@manaclaude/shared';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { BottomSheet } from '../../design/components/BottomSheet';
import { Card } from '../../design/components/Card';
import { DonutChart, LineChart } from '../../design/components/charts/Charts';
import { Badge, Dot, SegmentedControl } from '../../design/components/Controls';
import { Avatar, SectionHeader } from '../../design/components/Decor';
import { HStack, VStack } from '../../design/components/Layout';
import { ListRow } from '../../design/components/ListRow';
import { MoneyText } from '../../design/components/MoneyText';
import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import { currentNetWorth, netWorthHistory } from '../../data/metrics';
import { useToday } from '../../data/selectors';
import { useFinance } from '../../data/store';
import { Amount } from '../currency/Amount';
import { CurrencyChip } from '../currency/CurrencyChip';
import { useMoneyDisplay } from '../currency/useMoneyDisplay';

type Range = '3M' | '6M' | '1Y';
const RANGE_MONTHS: Record<Range, number> = { '3M': 3, '6M': 6, '1Y': 12 };

const ASSET_CLASS_LABEL: Record<Security['assetClass'], string> = {
  us_stocks: 'US stocks',
  intl_stocks: 'International',
  india_stocks: 'India stocks',
  bonds: 'Bonds',
  crypto: 'Crypto',
  cash: 'Cash',
  other: 'Other',
};
const ASSET_CLASS_COLOR = {
  us_stocks: 'c1',
  intl_stocks: 'c3',
  india_stocks: 'c6',
  bonds: 'c5',
  crypto: 'c2',
  cash: 'c9',
  other: 'c12',
} as const;

const TYPE_LABEL: Record<AccountType, string> = {
  checking: 'Checking',
  savings: 'Savings',
  credit_card: 'Credit cards',
  cash: 'Cash',
  brokerage: 'Brokerage',
  retirement: 'Retirement',
  crypto: 'Crypto',
  loan: 'Loans',
  mortgage: 'Mortgage',
  property: 'Property',
  vehicle: 'Vehicles',
  other_asset: 'Other assets',
  other_liability: 'Other liabilities',
};

/**
 * Net worth and investments (session C owns this screen; it adds realized
 * gains, dividends, the S&P 500 benchmark chart and planning).
 */
export function NetWorthScreen() {
  const data = useFinance();
  const today = useToday();
  const display = useMoneyDisplay();
  const { theme } = useUnistyles();
  const currency = display.reportCurrency;
  const [range, setRange] = useState<Range>('1Y');
  const [scrub, setScrub] = useState<number | null>(null);
  const [lotsFor, setLotsFor] = useState<Holding | null>(null);

  const m = useMemo(() => {
    const nw = currentNetWorth(data, currency);
    const from = addMonths(today, -RANGE_MONTHS[range]);
    const history = netWorthHistory(data, currency).filter((p) => p.date >= from);
    const byType = new Map<AccountType, number>();
    for (const a of data.accounts) {
      const v = display.convert(a.balance, a.currency, currency) ?? 0;
      byType.set(a.type, (byType.get(a.type) ?? 0) + v);
    }
    const securities = new Map(data.securities.map((s) => [s.id, s]));
    const holdings = data.holdings
      .map((h) => {
        const value = display.convert(h.marketValue, h.currency, currency) ?? 0;
        const cost =
          h.costBasis === null ? null : (display.convert(h.costBasis, h.currency, currency) ?? 0);
        return {
          h,
          sec: securities.get(h.securityId),
          value,
          cost,
          gain: cost === null ? null : value - cost,
        };
      })
      .sort((a, b) => b.value - a.value);
    const invested = holdings.reduce((s, x) => s + x.value, 0);
    const costTotal = holdings.reduce((s, x) => s + (x.cost ?? 0), 0);
    const allocation = new Map<Security['assetClass'], number>();
    for (const x of holdings) {
      const k = x.sec?.assetClass ?? 'other';
      allocation.set(k, (allocation.get(k) ?? 0) + x.value);
    }
    return { nw, history, byType, holdings, invested, costTotal, allocation };
  }, [data, currency, range, today, display]);

  const point = scrub !== null ? m.history[scrub] : undefined;
  const shown = point?.value ?? m.nw.netWorth;
  const first = m.history[0]?.value ?? shown;
  const change = shown - first;
  const lots = lotsFor ? data.taxLots.filter((l) => l.holdingId === lotsFor.id) : [];
  const lotsSecurity = lotsFor
    ? data.securities.find((s) => s.id === lotsFor.securityId)
    : undefined;

  const assetTypes = [...m.byType.entries()]
    .filter(([t, v]) => classifyAccountType(t) === 'asset' && v !== 0)
    .sort((a, b) => b[1] - a[1]);
  const liabilityTypes = [...m.byType.entries()].filter(
    ([t, v]) => classifyAccountType(t) === 'liability' && v !== 0,
  );

  return (
    <Screen title="Net worth" actions={<CurrencyChip />} testID="screen-networth">
      <Card>
        <VStack gap="sm">
          <Text variant="label" tone="muted">
            {point ? formatShortDate(point.date, today) : 'Net worth today'}
          </Text>
          <Amount
            amount={shown}
            currency={currency}
            size="hero"
            align="left"
            format={{ cents: 'never' }}
          />
          <HStack gap="xs">
            <MoneyText
              amount={change}
              currency={currency}
              size="small"
              colorize="signed"
              format={{ cents: 'never', sign: 'always' }}
            />
            <Text
              variant="caption"
              tone="muted"
            >{`over ${range === '1Y' ? 'the year' : RANGE_MONTHS[range] + ' months'}`}</Text>
          </HStack>
          <LineChart
            values={m.history.map((p) => p.value)}
            role="netWorth"
            onScrub={setScrub}
            accessibilityLabel="Net worth history"
            testID="networth-chart"
          />
          <SegmentedControl
            accessibilityLabel="Chart range"
            options={[
              { value: '3M', label: '3M' },
              { value: '6M', label: '6M' },
              { value: '1Y', label: '1Y' },
            ]}
            value={range}
            onChange={setRange}
          />
        </VStack>
      </Card>

      <View style={styles.grid}>
        <Card style={styles.half}>
          <VStack gap="sm">
            <HStack justify="space-between">
              <Text variant="label" tone="muted">
                Assets
              </Text>
              <MoneyText amount={m.nw.assets} currency={currency} format={{ cents: 'never' }} />
            </HStack>
            {assetTypes.map(([t, v]) => (
              <HStack key={t} justify="space-between">
                <Text variant="body" tone="muted">
                  {TYPE_LABEL[t]}
                </Text>
                <MoneyText
                  amount={v}
                  currency={currency}
                  size="small"
                  format={{ cents: 'never' }}
                />
              </HStack>
            ))}
          </VStack>
        </Card>
        <Card style={styles.half}>
          <VStack gap="sm">
            <HStack justify="space-between">
              <Text variant="label" tone="muted">
                Liabilities
              </Text>
              <MoneyText
                amount={m.nw.liabilities}
                currency={currency}
                tone="spending"
                format={{ cents: 'never' }}
              />
            </HStack>
            {liabilityTypes.map(([t, v]) => (
              <HStack key={t} justify="space-between">
                <Text variant="body" tone="muted">
                  {TYPE_LABEL[t]}
                </Text>
                <MoneyText
                  amount={v}
                  currency={currency}
                  size="small"
                  format={{ cents: 'never' }}
                />
              </HStack>
            ))}
          </VStack>
        </Card>
      </View>

      <SectionHeader title="Investments" />
      <Card>
        <HStack gap="lg">
          <DonutChart
            size="small"
            accessibilityLabel="Allocation by asset class"
            segments={[...m.allocation.entries()].map(([k, v]) => ({
              key: k,
              value: v,
              color: theme.colors.category[ASSET_CLASS_COLOR[k]],
            }))}
          />
          <VStack gap="xs" flex={1}>
            <Text variant="label" tone="muted">
              Invested
            </Text>
            <MoneyText
              amount={m.invested}
              currency={currency}
              size="large"
              format={{ cents: 'never' }}
            />
            <HStack gap="xs">
              <MoneyText
                amount={m.invested - m.costTotal}
                currency={currency}
                size="small"
                colorize="signed"
                format={{ cents: 'never', sign: 'always' }}
              />
              <Text variant="caption" tone="muted">
                unrealized
              </Text>
            </HStack>
            {[...m.allocation.entries()].map(([k, v]) => (
              <HStack key={k} gap="xs">
                <Dot color={theme.colors.category[ASSET_CLASS_COLOR[k]]} />
                <Text variant="caption" tone="muted" style={styles.flex}>
                  {ASSET_CLASS_LABEL[k]}
                </Text>
                <Text
                  variant="caption"
                  numeric
                >{`${Math.round((v / Math.max(1, m.invested)) * 100)}%`}</Text>
              </HStack>
            ))}
          </VStack>
        </HStack>
      </Card>
      <Card padding="none">
        {m.holdings.map(({ h, sec, value, gain, cost }) => (
          <ListRow
            key={h.id}
            title={sec?.symbol ?? h.securityId}
            subtitle={`${decToNumber(h.quantity).toLocaleString(undefined, { maximumFractionDigits: 4 })} · ${sec?.name ?? ''}`}
            leading={
              <Avatar
                label={sec?.symbol ?? '?'}
                color={ASSET_CLASS_COLOR[sec?.assetClass ?? 'other']}
              />
            }
            onPress={() => setLotsFor(h)}
            showChevron
            trailing={
              <VStack align="flex-end" gap="xxs">
                <MoneyText amount={value} currency={currency} format={{ cents: 'never' }} />
                {gain !== null && cost ? (
                  <Text
                    variant="caption"
                    tone={gain >= 0 ? 'income' : 'spending'}
                    numeric
                  >{`${gain >= 0 ? '+' : '−'}${Math.abs((gain / cost) * 100).toFixed(1)}%`}</Text>
                ) : null}
              </VStack>
            }
            testID={`holding-${h.id}`}
          />
        ))}
      </Card>

      <BottomSheet
        visible={lotsFor !== null}
        onClose={() => setLotsFor(null)}
        title={lotsSecurity ? `${lotsSecurity.symbol} lots` : 'Lots'}
        scrollable
      >
        <VStack gap="xs">
          <HStack style={styles.lotHeader}>
            {['Acquired', 'Qty', 'Cost', 'Gain', 'Term'].map((h) => (
              <Text key={h} variant="micro" tone="muted" uppercase style={styles.lotCell}>
                {h}
              </Text>
            ))}
          </HStack>
          {lots.map((lot) => {
            const perf = lotPerformance(lot, lotsFor?.price ?? '0', today);
            return (
              <HStack key={lot.id} style={styles.lotRow}>
                <Text variant="caption" numeric style={styles.lotCell}>
                  {formatShortDate(lot.acquiredOn, today)}
                </Text>
                <Text variant="caption" numeric style={styles.lotCell}>
                  {decToNumber(lot.quantity).toLocaleString(undefined, {
                    maximumFractionDigits: 4,
                  })}
                </Text>
                <View style={styles.lotCell}>
                  <MoneyText
                    amount={lot.costBasis}
                    currency={lot.currency}
                    size="small"
                    format={{ cents: 'never' }}
                  />
                </View>
                <View style={styles.lotCell}>
                  <MoneyText
                    amount={perf.gain}
                    currency={lot.currency}
                    size="small"
                    colorize="signed"
                    format={{ cents: 'never' }}
                  />
                </View>
                <View style={styles.lotCell}>
                  <Badge label={perf.term} tone={perf.term === 'long' ? 'income' : 'neutral'} />
                </View>
              </HStack>
            );
          })}
          <Text variant="caption" tone="faint">
            {lots[0]?.source === 'broker'
              ? 'Lots from the broker.'
              : 'Lots derived from buys and sells, first in first out.'}
          </Text>
        </VStack>
      </BottomSheet>
    </Screen>
  );
}

const styles = StyleSheet.create((theme) => ({
  grid: { flexDirection: { xs: 'column', sm: 'row' }, gap: theme.space.md },
  half: { flex: { xs: undefined, sm: 1 } },
  flex: { flex: 1 },
  lotHeader: {
    paddingVertical: theme.space.xs,
    borderBottomWidth: theme.size.hairline,
    borderColor: theme.colors.border,
  },
  lotRow: { paddingVertical: theme.space.xs },
  lotCell: { flex: 1 },
}));
