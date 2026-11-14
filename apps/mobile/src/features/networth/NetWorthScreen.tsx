import { useMemo, useState } from 'react';
import { View } from 'react-native';
import {
  addMonths,
  classifyAccountType,
  formatShortDate,
  type AccountType,
  type Security,
} from '@manaclaude/shared';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Card } from '../../design/components/Card';
import { DonutChart, LineChart } from '../../design/components/charts/Charts';
import { Dot, SegmentedControl } from '../../design/components/Controls';
import { SectionHeader } from '../../design/components/Decor';
import { HStack, VStack } from '../../design/components/Layout';
import { Icon } from '../../design/components/Icon';
import { MoneyText } from '../../design/components/MoneyText';
import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import { currentNetWorth, netWorthByType, netWorthHistory } from '../../data/metrics';
import { useToday } from '../../data/selectors';
import { useFinance } from '../../data/store';
import { Amount } from '../currency/Amount';
import { CurrencyChip } from '../currency/CurrencyChip';
import { useMoneyDisplay } from '../currency/useMoneyDisplay';
import { goTo } from '../planning/navigate';
import { noRateText } from './leftOut';

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

  const m = useMemo(() => {
    const nw = currentNetWorth(data, currency);
    const from = addMonths(today, -RANGE_MONTHS[range]);
    const history = netWorthHistory(data, currency).filter((p) => p.date >= from);
    // Only what net worth counts: accounts switched out of it or with an unknown balance are left out.
    const { byType, unknown, noRate } = netWorthByType(data, currency);
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
    return { nw, history, byType, unknown, noRate, holdings, invested, costTotal, allocation };
  }, [data, currency, range, today, display]);

  const point = scrub !== null ? m.history[scrub] : undefined;
  const shown = point?.value ?? m.nw.netWorth;
  const first = m.history[0]?.value ?? shown;
  const change = shown - first;
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

      {m.unknown.length > 0 ? (
        <Text variant="caption" tone="muted" testID="networth-unknown">
          {m.unknown.length === 1
            ? `Leaves out "${m.unknown[0]!.name}": its balance is unknown. Enter it on the account's page to count it.`
            : `Leaves out ${m.unknown.length} accounts whose balance is unknown: ${m.unknown.map((a) => `"${a.name}"`).join(', ')}. Enter a balance on each account's page to count it.`}
        </Text>
      ) : null}

      {m.noRate.length > 0 ? (
        <Text variant="caption" tone="muted" testID="networth-no-rate">
          {noRateText(m.noRate, currency)}
        </Text>
      ) : null}

      <SectionHeader title="Investments" />
      <Card onPress={() => goTo('/networth/investments')} accessibilityLabel="Open investments">
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
            <Amount
              amount={m.invested}
              currency={currency}
              size="large"
              align="left"
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
            <Text variant="caption" tone="accent">
              Lots, realized gains, dividends and S&P 500 benchmark
            </Text>
          </VStack>
        </HStack>
      </Card>
      <Card onPress={() => goTo('/planning')} accessibilityLabel="Open retirement and goals">
        <HStack gap="md">
          <Icon name="piggy-bank" tone="netWorth" />
          <VStack flex={1} gap="xxs">
            <Text variant="bodyStrong">Retirement and goals</Text>
            <Text variant="caption" tone="muted">
              FIRE projection with your return, inflation and savings
            </Text>
          </VStack>
          <Icon name="chevron-right" tone="muted" />
        </HStack>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create((theme) => ({
  grid: { flexDirection: { xs: 'column', sm: 'row' }, gap: theme.space.md },
  half: { flex: { xs: undefined, sm: 1 } },
  flex: { flex: 1 },
}));
