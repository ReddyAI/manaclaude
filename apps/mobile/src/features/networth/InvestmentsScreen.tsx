import { useMemo, useState } from 'react';
import { View } from 'react-native';
import {
  addMonths,
  allocationByClass,
  benchmarkComparison,
  decToNumber,
  dividendsByYear,
  findRate,
  formatShortDate,
  fromMajor,
  resultsFromActivities,
  summarizePosition,
  summarizeRealized,
  type Holding,
  type Security,
} from '@manaclaude/shared';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { BottomSheet } from '../../design/components/BottomSheet';
import { Card } from '../../design/components/Card';
import { DonutChart, LineChart } from '../../design/components/charts/Charts';
import { Badge, Chip, Dot, SegmentedControl } from '../../design/components/Controls';
import { Avatar, EmptyState, SectionHeader } from '../../design/components/Decor';
import { HStack, VStack } from '../../design/components/Layout';
import { ListRow } from '../../design/components/ListRow';
import { MoneyText } from '../../design/components/MoneyText';
import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import { useToday } from '../../data/selectors';
import { useFinance } from '../../data/store';
import { Amount, DualAmount } from '../currency/Amount';
import { CurrencyChip } from '../currency/CurrencyChip';
import { skippedItemsText } from '../currency/missingRates';
import { pickDual, useMoneyDisplay } from '../currency/useMoneyDisplay';
import { BackAction } from '../planning/BackAction';
import { benchmarkLeftOut } from './benchmarkNoRate';

type BenchRange = '6M' | '1Y' | '2Y';
const BENCH_MONTHS: Record<BenchRange, number> = { '6M': 6, '1Y': 12, '2Y': 24 };

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

const qty = (q: string) => decToNumber(q).toLocaleString(undefined, { maximumFractionDigits: 4 });
const pct = (v: number | null) =>
  v === null ? '' : `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}%`;

/**
 * Investments (session C): positions with per-lot tables, unrealized and
 * realized gains (FIFO), dividends, allocation and the S&P 500 benchmark.
 */
export function InvestmentsScreen() {
  const data = useFinance();
  const today = useToday();
  const display = useMoneyDisplay();
  const { theme } = useUnistyles();
  const currency = display.reportCurrency;
  const [range, setRange] = useState<BenchRange>('1Y');
  const [year, setYear] = useState<number | 'all'>('all');
  const [open, setOpen] = useState<Holding | null>(null);
  const [showAllRealized, setShowAllRealized] = useState(false);

  const securities = useMemo(
    () => new Map(data.securities.map((s) => [s.id, s])),
    [data.securities],
  );
  const conv = (amount: number, from: string, date?: string) =>
    display.convert(amount, from, currency, date) ?? 0;

  const positions = useMemo(
    () =>
      data.holdings
        .map((h) => ({
          h,
          sec: securities.get(h.securityId),
          summary: summarizePosition(h, data.taxLots, today),
        }))
        .sort(
          (a, b) =>
            (display.convert(b.h.marketValue, b.h.currency, currency) ?? 0) -
            (display.convert(a.h.marketValue, a.h.currency, currency) ?? 0),
        ),
    [data.holdings, data.taxLots, securities, today, display, currency],
  );

  const totals = useMemo(
    () =>
      display.dual((cur) => {
        let value = 0;
        let cost = 0;
        for (const p of positions) {
          value += display.convert(p.h.marketValue, p.h.currency, cur) ?? 0;
          cost += display.convert(p.summary.costBasis, p.h.currency, cur) ?? 0;
        }
        return { value, cost, unrealized: value - cost };
      }),
    [positions, display],
  );

  const allocation = useMemo(
    () =>
      allocationByClass(
        data.holdings,
        data.securities,
        (h) => display.convert(h.marketValue, h.currency, currency) ?? 0,
      ),
    [data.holdings, data.securities, display, currency],
  );

  const activity = useMemo(() => resultsFromActivities(data.activities), [data.activities]);
  const years = useMemo(
    () =>
      [...new Set(activity.realized.map((r) => Number(r.soldOn.slice(0, 4))))].sort(
        (a, b) => b - a,
      ),
    [activity.realized],
  );

  const realized = useMemo(
    () =>
      display.dual((cur) =>
        summarizeRealized(activity.realized, {
          year: year === 'all' ? undefined : year,
          // Realized gains convert at the rate on the day of the sale.
          convert: (amount, g) => display.convert(amount, g.currency, cur, g.soldOn) ?? 0,
        }),
      ),
    [activity.realized, year, display],
  );

  const dividendYears = useMemo(
    () =>
      display.dual((cur) =>
        dividendsByYear(
          activity.dividends,
          (d) => display.convert(d.amount, d.currency, cur, d.date) ?? 0,
        ),
      ),
    [activity.dividends, display],
  );

  // What each total leaves out for want of an exchange rate to the report
  // currency (it adds 0), named by symbol, once per symbol.
  const noRate = useMemo(() => {
    const symbol = (id: string | null, fallback: string) =>
      (id ? securities.get(id)?.symbol : undefined) ?? fallback;
    const once = (list: { name: string; currency: string }[]) => [
      ...new Map(list.map((x) => [`${x.name}|${x.currency}`, x])).values(),
    ];
    const holdings = once(
      data.holdings
        .filter((h) => display.convert(h.marketValue, h.currency, currency) === null)
        .map((h) => ({ name: symbol(h.securityId, h.securityId), currency: h.currency })),
    );
    const sold = once(
      activity.realized
        .filter((r) => year === 'all' || Number(r.soldOn.slice(0, 4)) === year)
        .filter((r) => display.convert(r.gain, r.currency, currency, r.soldOn) === null)
        .map((r) => ({ name: symbol(r.securityId, r.securityId), currency: r.currency })),
    );
    const paid = once(
      activity.dividends
        .filter((d) => display.convert(d.amount, d.currency, currency, d.date) === null)
        .map((d) => ({
          name: symbol(d.securityId, d.type === 'interest' ? 'Interest' : 'Dividend'),
          currency: d.currency,
        })),
    );
    return {
      holdings: skippedItemsText(holdings, currency, 'holdings'),
      realized: skippedItemsText(sold, currency, 'holdings'),
      dividends: skippedItemsText(paid, currency, 'holdings'),
    };
  }, [data.holdings, activity, securities, year, display, currency]);

  const benchSecurity = data.securities.find((s) => s.isBenchmark) ?? null;
  const bench = useMemo(() => {
    if (!benchSecurity) return null;
    const from = addMonths(today, -BENCH_MONTHS[range]);
    const dates = data.prices
      .filter((p) => p.securityId === benchSecurity.id && p.date >= from)
      .map((p) => p.date)
      .sort();
    const fx = (cur: string) => (c: string) =>
      c === cur ? 1 : (findRate(data.fxRates, c, cur)?.rate ?? null);
    const result = display.dual((cur) =>
      benchmarkComparison({
        activities: data.activities,
        prices: data.prices,
        benchmarkSecurityId: benchSecurity.id,
        dates,
        fx: fx(cur),
      }),
    );
    // What the comparison leaves out for want of a rate to the report
    // currency, named by symbol.
    const leftOut = benchmarkLeftOut({
      activities: data.activities,
      prices: data.prices,
      dates,
      fx: fx(currency),
    }).map((x) => ({
      name: securities.get(x.securityId)?.symbol ?? x.securityId,
      currency: x.currency,
    }));
    return { ...result, noRate: skippedItemsText(leftOut, currency, 'holdings') };
  }, [
    benchSecurity,
    data.activities,
    data.prices,
    data.fxRates,
    range,
    today,
    display,
    currency,
    securities,
  ]);

  const openSecurity = open ? securities.get(open.securityId) : undefined;
  const openSummary = open ? summarizePosition(open, data.taxLots, today) : null;
  const realizedRows = activity.realized.filter(
    (r) => year === 'all' || Number(r.soldOn.slice(0, 4)) === year,
  );
  const shownRows = showAllRealized ? realizedRows : realizedRows.slice(0, 8);
  const lastDividend = dividendYears.main[0];

  return (
    <Screen
      title="Investments"
      actions={
        <HStack gap="xs">
          <BackAction />
          <CurrencyChip />
        </HStack>
      }
      testID="screen-investments"
    >
      <Card>
        <VStack gap="md">
          <HStack gap="lg" align="center">
            <DonutChart
              size="small"
              accessibilityLabel="Allocation by asset class"
              segments={allocation.map((a) => ({
                key: a.assetClass,
                value: a.value,
                color: theme.colors.category[ASSET_CLASS_COLOR[a.assetClass]],
              }))}
            />
            <VStack gap="xs" flex={1}>
              <Text variant="label" tone="muted">
                Invested
              </Text>
              <DualAmount
                {...pickDual(display, totals, (t) => t.value)}
                size="large"
                align="left"
                format={{ cents: 'never' }}
                testID="invest-total"
              />
              <HStack gap="xs" wrap>
                <DualAmount
                  {...pickDual(display, totals, (t) => t.unrealized)}
                  size="small"
                  colorize="signed"
                  align="left"
                  format={{ cents: 'never', sign: 'always' }}
                  testID="invest-unrealized"
                />
                <Text variant="caption" tone="muted">
                  unrealized
                </Text>
              </HStack>
            </VStack>
          </HStack>
          <VStack gap="xs">
            {allocation.map((a) => (
              <HStack key={a.assetClass} gap="xs">
                <Dot color={theme.colors.category[ASSET_CLASS_COLOR[a.assetClass]]} />
                <Text variant="caption" tone="muted" style={styles.flex}>
                  {ASSET_CLASS_LABEL[a.assetClass]}
                </Text>
                <Text variant="caption" numeric>{`${Math.round(a.share * 100)}%`}</Text>
              </HStack>
            ))}
          </VStack>
          {noRate.holdings ? (
            <Text variant="caption" tone="muted" testID="invest-holdings-no-rate">
              {`Value, cost and gains: ${noRate.holdings}`}
            </Text>
          ) : null}
        </VStack>
      </Card>

      {bench && benchSecurity ? (
        <View>
          <SectionHeader title="Against the S&P 500" />
          <Card>
            <VStack gap="sm">
              <HStack justify="space-between" align="flex-start">
                <VStack gap="xxs">
                  <Text variant="label" tone="muted">
                    Your portfolio
                  </Text>
                  <DualAmount
                    {...pickDual(display, bench, (b) => fromMajor(b.portfolioGain, currency))}
                    size="medium"
                    colorize="signed"
                    align="left"
                    format={{ cents: 'never', sign: 'always' }}
                    testID="bench-portfolio"
                  />
                </VStack>
                <VStack gap="xxs" align="flex-end">
                  <Text variant="label" tone="muted">
                    Same money in the S&P 500
                  </Text>
                  <DualAmount
                    {...pickDual(display, bench, (b) => fromMajor(b.benchmarkGain, currency))}
                    size="medium"
                    colorize="signed"
                    format={{ cents: 'never', sign: 'always' }}
                    testID="bench-index"
                  />
                </VStack>
              </HStack>
              {bench.main.points.length > 1 ? (
                <LineChart
                  values={bench.main.points.map((p) => p.portfolio)}
                  compare={bench.main.points.map((p) => p.benchmark)}
                  role="netWorth"
                  height="small"
                  accessibilityLabel="Portfolio value against the same money in the S&P 500"
                  testID="bench-chart"
                />
              ) : null}
              <Text variant="caption" tone="muted">
                {bench.main.difference >= 0 ? 'Ahead of the index by ' : 'Behind the index by '}
                <MoneyText
                  amount={Math.abs(fromMajor(bench.main.difference, currency))}
                  currency={currency}
                  size="small"
                  tone="muted"
                  format={{ cents: 'never' }}
                />
                . Dashed line is the index. Price return only, accounts with trade history.
              </Text>
              {bench.noRate ? (
                <Text variant="caption" tone="muted" testID="bench-no-rate">
                  {`Comparison: ${bench.noRate}`}
                </Text>
              ) : null}
              <SegmentedControl
                accessibilityLabel="Benchmark range"
                value={range}
                onChange={setRange}
                options={[
                  { value: '6M', label: '6M' },
                  { value: '1Y', label: '1Y' },
                  { value: '2Y', label: '2Y' },
                ]}
              />
            </VStack>
          </Card>
        </View>
      ) : null}

      <View>
        <SectionHeader title="Positions" />
        <Card padding="none">
          {positions.map(({ h, sec, summary }) => (
            <ListRow
              key={h.id}
              title={sec?.symbol ?? h.securityId}
              subtitle={`${qty(h.quantity)} · ${sec?.name ?? ''}`}
              leading={
                <Avatar
                  label={sec?.symbol ?? '?'}
                  color={ASSET_CLASS_COLOR[sec?.assetClass ?? 'other']}
                />
              }
              onPress={() => setOpen(h)}
              showChevron
              trailing={
                <VStack align="flex-end" gap="xxs">
                  <Amount
                    amount={h.marketValue}
                    currency={h.currency}
                    format={{ cents: 'never' }}
                  />
                  <Text
                    variant="caption"
                    tone={summary.unrealized >= 0 ? 'income' : 'spending'}
                    numeric
                  >
                    {pct(summary.unrealizedPct)}
                  </Text>
                </VStack>
              }
              testID={`holding-${h.id}`}
            />
          ))}
        </Card>
      </View>

      <View>
        <SectionHeader title="Realized gains" />
        <Card>
          <VStack gap="sm">
            <HStack gap="xs" wrap>
              <Chip label="All years" selected={year === 'all'} onPress={() => setYear('all')} />
              {years.map((y) => (
                <Chip key={y} label={String(y)} selected={year === y} onPress={() => setYear(y)} />
              ))}
            </HStack>
            <HStack justify="space-between" align="flex-start">
              <VStack gap="xxs">
                <Text variant="label" tone="muted">
                  Total
                </Text>
                <DualAmount
                  {...pickDual(display, realized, (r) => r.gain)}
                  size="large"
                  colorize="signed"
                  align="left"
                  format={{ cents: 'never', sign: 'always' }}
                  testID="realized-total"
                />
              </VStack>
              <VStack gap="xxs" align="flex-end">
                <HStack gap="xs">
                  <Text variant="caption" tone="muted">
                    Short term
                  </Text>
                  <MoneyText
                    amount={realized.main.shortTermGain}
                    currency={currency}
                    size="small"
                    colorize="signed"
                    format={{ cents: 'never', sign: 'always' }}
                  />
                </HStack>
                <HStack gap="xs">
                  <Text variant="caption" tone="muted">
                    Long term
                  </Text>
                  <MoneyText
                    amount={realized.main.longTermGain}
                    currency={currency}
                    size="small"
                    colorize="signed"
                    format={{ cents: 'never', sign: 'always' }}
                  />
                </HStack>
              </VStack>
            </HStack>
          </VStack>
        </Card>
        {realizedRows.length === 0 ? (
          <EmptyState
            icon="coins"
            title="No sells yet"
            message="Realized gains appear after a sell."
          />
        ) : (
          <Card padding="none">
            {shownRows.map((r, i) => (
              <ListRow
                key={`${r.securityId}-${r.soldOn}-${r.acquiredOn}-${i}`}
                title={securities.get(r.securityId)?.symbol ?? r.securityId}
                subtitle={`Sold ${formatShortDate(r.soldOn, today)} · ${qty(r.quantity)} bought ${formatShortDate(r.acquiredOn, today)}`}
                trailing={
                  <VStack align="flex-end" gap="xxs">
                    <MoneyText
                      amount={conv(r.gain, r.currency, r.soldOn)}
                      currency={currency}
                      colorize="signed"
                      format={{ cents: 'never', sign: 'always' }}
                    />
                    <Badge label={r.term} tone={r.term === 'long' ? 'income' : 'neutral'} />
                  </VStack>
                }
                testID={`realized-${i}`}
              />
            ))}
          </Card>
        )}
        {realizedRows.length > 8 ? (
          <Chip
            label={showAllRealized ? 'Show fewer' : `Show all ${realizedRows.length}`}
            onPress={() => setShowAllRealized((v) => !v)}
          />
        ) : null}
        {noRate.realized ? (
          <Text variant="caption" tone="muted" testID="invest-realized-no-rate">
            {`Realized gains: ${noRate.realized}`}
          </Text>
        ) : null}
        <Text variant="caption" tone="faint">
          First in, first out. Converted with the rate on the day of each sale.
        </Text>
      </View>

      <View style={styles.last}>
        <SectionHeader title="Dividends" />
        <Card padding="none">
          {dividendYears.main.length === 0 ? (
            <EmptyState icon="coins" title="No dividends yet" />
          ) : (
            dividendYears.main.map((d) => (
              <ListRow
                key={d.year}
                title={String(d.year)}
                subtitle={d.year === lastDividend?.year ? 'Latest year' : undefined}
                trailing={
                  <DualAmount
                    {...pickDual(
                      display,
                      dividendYears,
                      (list) => list.find((x) => x.year === d.year)?.amount ?? 0,
                    )}
                    size="small"
                    format={{ cents: 'never' }}
                  />
                }
                testID={`dividends-${d.year}`}
              />
            ))
          )}
        </Card>
        {noRate.dividends ? (
          <Text variant="caption" tone="muted" testID="invest-dividends-no-rate">
            {`Dividends: ${noRate.dividends}`}
          </Text>
        ) : null}
      </View>

      <BottomSheet
        visible={open !== null}
        onClose={() => setOpen(null)}
        title={openSecurity ? `${openSecurity.symbol} lots` : 'Lots'}
        scrollable
        testID="lots-sheet"
      >
        {open && openSummary ? (
          <VStack gap="sm">
            <HStack justify="space-between">
              <VStack gap="xxs">
                <Text variant="label" tone="muted">
                  Cost basis
                </Text>
                <Amount
                  amount={openSummary.costBasis}
                  currency={open.currency}
                  align="left"
                  format={{ cents: 'never' }}
                  testID="position-cost"
                />
              </VStack>
              <VStack gap="xxs" align="flex-end">
                <Text variant="label" tone="muted">
                  Unrealized {pct(openSummary.unrealizedPct)}
                </Text>
                <Amount
                  amount={openSummary.unrealized}
                  currency={open.currency}
                  colorize="signed"
                  format={{ cents: 'never', sign: 'always' }}
                  testID="position-unrealized"
                />
              </VStack>
            </HStack>
            <HStack justify="space-between">
              <Text variant="caption" tone="muted">
                Long term
              </Text>
              <MoneyText
                amount={conv(openSummary.longTermUnrealized, open.currency)}
                currency={currency}
                size="small"
                colorize="signed"
                format={{ cents: 'never', sign: 'always' }}
              />
            </HStack>
            <HStack justify="space-between">
              <Text variant="caption" tone="muted">
                Short term
              </Text>
              <MoneyText
                amount={conv(openSummary.shortTermUnrealized, open.currency)}
                currency={currency}
                size="small"
                colorize="signed"
                format={{ cents: 'never', sign: 'always' }}
              />
            </HStack>
            {display.convert(0, open.currency, currency) === null ? (
              <Text variant="caption" tone="muted" testID="position-no-rate">
                {`There is no ${open.currency} to ${currency} exchange rate yet, so the ${currency} amounts below add nothing and show 0. Refresh rates in Settings, Exchange rates.`}
              </Text>
            ) : null}
            <HStack style={styles.lotHeader}>
              {['Acquired', 'Qty', 'Cost', 'Gain / loss', 'Term'].map((h) => (
                <Text key={h} variant="micro" tone="muted" uppercase style={styles.lotCell}>
                  {h}
                </Text>
              ))}
            </HStack>
            {openSummary.lots.map(({ lot, perf }) => (
              <View key={lot.id} testID={`lot-${lot.id}`}>
                <HStack style={styles.lotRow}>
                  <Text variant="caption" numeric style={styles.lotCell}>
                    {formatShortDate(lot.acquiredOn, today)}
                  </Text>
                  <Text variant="caption" numeric style={styles.lotCell}>
                    {qty(lot.quantity)}
                  </Text>
                  <View style={styles.lotCell}>
                    <MoneyText
                      amount={conv(lot.costBasis, lot.currency)}
                      currency={currency}
                      size="small"
                      format={{ cents: 'never' }}
                    />
                  </View>
                  <View style={styles.lotCell}>
                    <MoneyText
                      amount={conv(perf.gain, lot.currency)}
                      currency={currency}
                      size="small"
                      colorize="signed"
                      format={{ cents: 'never', sign: 'always' }}
                    />
                    <Text variant="micro" tone="muted" numeric>
                      {pct(perf.gainPct)}
                    </Text>
                  </View>
                  <View style={styles.lotCell}>
                    <Badge label={perf.term} tone={perf.term === 'long' ? 'income' : 'neutral'} />
                  </View>
                </HStack>
              </View>
            ))}
            <Text variant="caption" tone="faint">
              {openSummary.lotSource === 'broker'
                ? 'Lots from the broker.'
                : openSummary.lotSource === 'derived'
                  ? 'Lots derived from buys and sells, first in first out.'
                  : 'No lot detail for this position.'}
            </Text>
          </VStack>
        ) : null}
      </BottomSheet>
    </Screen>
  );
}

const styles = StyleSheet.create((theme) => ({
  flex: { flex: 1 },
  last: { paddingBottom: theme.space.lg },
  lotHeader: {
    paddingVertical: theme.space.xs,
    borderBottomWidth: theme.size.hairline,
    borderColor: theme.colors.border,
  },
  lotRow: { paddingVertical: theme.space.xs, alignItems: 'center' },
  lotCell: { flex: 1 },
}));
