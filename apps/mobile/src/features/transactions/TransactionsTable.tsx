import { FlashList } from '@shopify/flash-list';
import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import { formatShortDate, type Transaction } from '@manaclaude/shared';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Icon } from '../../design/components/Icon';
import { MoneyText } from '../../design/components/MoneyText';
import { Text } from '../../design/components/Text';
import { haptic } from '../../design/haptics';
import type { Lookups } from '../../data/selectors';
import { Amount } from '../currency/Amount';
import { selectedNoRateText } from '../currency/missingRates';
import { useMoneyDisplay } from '../currency/useMoneyDisplay';
import { describeTransaction, isListed } from './display';

/**
 * Spreadsheet-style table for the Compact look on wide screens: resizable
 * columns (drag a header edge) and bulk-select with a running total.
 */

type ColumnKey = 'date' | 'name' | 'category' | 'account' | 'amount';

interface ColumnDef {
  key: ColumnKey;
  title: string;
  /** Initial width as a multiple of the theme's touch target. */
  units: number;
  align?: 'right';
}

const COLUMNS: ColumnDef[] = [
  { key: 'date', title: 'Date', units: 2 },
  { key: 'name', title: 'Name', units: 6 },
  { key: 'category', title: 'Category', units: 4 },
  { key: 'account', title: 'Account', units: 4 },
  { key: 'amount', title: 'Amount', units: 3, align: 'right' },
];

function ResizeHandle({ onResize }: { onResize: (dx: number) => void }) {
  const pan = usePanGesture({
    runOnJS: true,
    minDistance: 1,
    onUpdate: (e) => onResize(e.changeX),
  });
  return (
    <GestureDetector gesture={pan}>
      <View style={styles.handle} accessibilityLabel="Resize column" />
    </GestureDetector>
  );
}

export function TransactionsTable({
  transactions,
  lookups,
  onOpen,
}: {
  transactions: readonly Transaction[];
  lookups: Lookups;
  onOpen: (t: Transaction) => void;
}) {
  const { theme } = useUnistyles();
  const display = useMoneyDisplay();
  const minWidth = theme.size.touchTarget * 1.5;
  const [widths, setWidths] = useState<Record<ColumnKey, number>>(
    () =>
      Object.fromEntries(COLUMNS.map((c) => [c.key, c.units * theme.size.touchTarget])) as Record<
        ColumnKey,
        number
      >,
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const rows = useMemo(
    () =>
      transactions.filter((t) => isListed(t, lookups)).map((t) => describeTransaction(t, lookups)),
    [transactions, lookups],
  );
  const selectedTotal = useMemo(
    () =>
      display.total(
        rows
          .filter((r) => selected.has(r.key))
          .map((r) => ({ amount: r.txn.amount, currency: r.txn.currency, date: r.txn.date })),
      ),
    [rows, selected, display],
  );

  const selectedNoRate = useMemo(
    () =>
      selectedNoRateText(
        rows.filter(
          (r) =>
            selected.has(r.key) &&
            display.convert(r.txn.amount, r.txn.currency, display.reportCurrency, r.txn.date) ===
              null,
        ).length,
        display.reportCurrency,
      ),
    [rows, selected, display],
  );

  const toggle = (id: string) => {
    haptic('selection');
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const allSelected = rows.length > 0 && selected.size === rows.length;

  return (
    <View style={styles.wrap}>
      <View style={styles.headerRow}>
        <Pressable
          onPress={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.key)))}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: allSelected }}
          accessibilityLabel="Select all"
          style={styles.checkCell}
        >
          <View style={styles.checkbox(allSelected)}>
            {allSelected ? <Icon name="check" size="xs" tone="onAccent" /> : null}
          </View>
        </Pressable>
        {COLUMNS.map((c) => (
          <View key={c.key} style={styles.cell(widths[c.key], c.align)}>
            <Text variant="micro" tone="muted" uppercase numberOfLines={1}>
              {c.title}
            </Text>
            <ResizeHandle
              onResize={(dx) =>
                setWidths((w) => ({ ...w, [c.key]: Math.max(minWidth, w[c.key] + dx) }))
              }
            />
          </View>
        ))}
      </View>
      <FlashList
        data={rows}
        keyExtractor={(r) => r.key}
        renderItem={({ item }) => {
          const isSel = selected.has(item.key);
          const category = item.txn.categoryId
            ? lookups.categoriesById.get(item.txn.categoryId)
            : undefined;
          return (
            <Pressable
              onPress={() => onOpen(item.txn)}
              style={styles.row(isSel)}
              accessibilityLabel={item.title}
              testID={`txn-${item.txn.id}`}
            >
              <Pressable
                onPress={() => toggle(item.key)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: isSel }}
                accessibilityLabel={`Select ${item.title}`}
                style={styles.checkCell}
              >
                <View style={styles.checkbox(isSel)}>
                  {isSel ? <Icon name="check" size="xs" tone="onAccent" /> : null}
                </View>
              </Pressable>
              <View style={styles.cell(widths.date)}>
                <Text variant="body" tone="muted" numeric numberOfLines={1}>
                  {formatShortDate(item.txn.date)}
                </Text>
              </View>
              <View style={[styles.cell(widths.name), styles.nameCell]}>
                {item.transfer ? (
                  <Icon name="link" size="xs" tone="muted" />
                ) : !item.txn.reviewed ? (
                  <View style={styles.unreviewed} accessibilityLabel="Not reviewed" />
                ) : null}
                <Text variant="bodyStrong" numberOfLines={1} style={styles.nameText}>
                  {item.title}
                </Text>
              </View>
              <View style={styles.cell(widths.category)}>
                <Text variant="body" tone={category ? 'default' : 'faint'} numberOfLines={1}>
                  {item.transfer ? item.subtitle : (category?.name ?? 'Uncategorized')}
                </Text>
              </View>
              <View style={styles.cell(widths.account)}>
                <Text variant="body" tone="muted" numberOfLines={1}>
                  {lookups.accountsById.get(item.txn.accountId)?.name}
                </Text>
              </View>
              <View style={styles.cell(widths.amount, 'right')}>
                <Amount
                  amount={item.txn.amount}
                  currency={item.txn.currency}
                  date={item.txn.date}
                  size="small"
                  colorize={item.transfer ? 'none' : 'flow'}
                />
              </View>
            </Pressable>
          );
        }}
      />
      {selected.size > 0 ? (
        <View style={styles.footer}>
          <Text variant="label" testID="table-selected">
            {selectedNoRate
              ? `${selected.size} selected. ${selectedNoRate}`
              : `${selected.size} selected`}
          </Text>
          <MoneyText
            amount={selectedTotal.amount}
            currency={selectedTotal.currency}
            size="small"
            colorize="flow"
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  nameCell: { flexDirection: 'row', alignItems: 'center', gap: theme.space.xs },
  nameText: { flexShrink: 1 },
  unreviewed: {
    width: theme.size.dot,
    height: theme.size.dot,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.accent,
  },
  wrap: { flex: 1, borderTopWidth: theme.size.hairline, borderColor: theme.colors.border },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    height: theme.size.tableRowHeight,
    backgroundColor: theme.colors.surfaceSunken,
    borderBottomWidth: theme.size.hairline,
    borderColor: theme.colors.border,
  },
  row: (selected: boolean) => ({
    flexDirection: 'row',
    alignItems: 'center',
    height: theme.size.tableRowHeight,
    borderBottomWidth: theme.size.hairline,
    borderColor: theme.colors.border,
    backgroundColor: selected ? theme.colors.accentMuted : theme.colors.surface,
  }),
  checkCell: {
    width: theme.size.touchTarget,
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
  },
  checkbox: (checked: boolean) => ({
    width: theme.size.iconSm,
    height: theme.size.iconSm,
    borderRadius: theme.radius.sm,
    borderWidth: theme.size.borderWidth,
    borderColor: checked ? theme.colors.accent : theme.colors.borderStrong,
    backgroundColor: checked ? theme.colors.accent : 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  }),
  cell: (width: number, align?: 'right') => ({
    width,
    paddingHorizontal: theme.space.sm,
    height: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
  }),
  handle: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: theme.space.sm,
    borderRightWidth: theme.size.hairline,
    borderColor: theme.colors.borderStrong,
    cursor: 'col-resize',
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: theme.space.lg,
    height: theme.size.tableRowHeight,
    backgroundColor: theme.colors.surfaceRaised,
    borderTopWidth: theme.size.hairline,
    borderColor: theme.colors.border,
  },
}));
