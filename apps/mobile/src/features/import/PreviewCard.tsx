import { formatMoney, type Account, type ImportPreview } from '@manaclaude/shared';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Card } from '../../design/components/Card';
import { Badge, type BadgeTone } from '../../design/components/Controls';
import { VStack } from '../../design/components/Layout';
import { Text } from '../../design/components/Text';
import {
  commitLines,
  type ImportOptions,
  type ImportPlan,
  type Review,
  type TotalLine,
} from './importFlow';

const SHOWN_ROWS = 60;

/** Rows, money in and money out per account and currency: the numbers to hold against the source. */
export function TotalsTable({ totals }: { totals: readonly TotalLine[] }) {
  if (totals.length === 0) return null;
  return (
    <VStack gap="xs" testID="import-totals">
      {totals.map((t) => (
        <View key={t.key} style={styles.total} testID={`import-total-${t.label}-${t.currency}`}>
          <Text variant="bodyStrong" numberOfLines={1}>
            {`${t.label} · ${t.currency}${t.isNew ? ' (new account)' : ''}`}
          </Text>
          <Text variant="caption" tone="muted">
            {`${t.count} ${t.count === 1 ? 'row' : 'rows'} · in ${formatMoney(t.moneyIn, t.currency)} · out ${formatMoney(t.moneyOut, t.currency)}`}
          </Text>
        </View>
      ))}
    </VStack>
  );
}

/** What a save would do: the counts, the totals to compare, the backend's notes and the first rows. */
export function PreviewCard({
  preview,
  plan,
  options,
  review,
  accounts,
  dateOrderChosen,
}: {
  preview: ImportPreview;
  plan: ImportPlan;
  /** The preview was made with a date order picked by hand. */
  dateOrderChosen: boolean;
  options: ImportOptions;
  review: Review;
  accounts: readonly Account[];
}) {
  const skipped = new Set(commitLines(preview, options, review).skipLines);
  const candidates = new Set((preview.duplicateCandidates ?? []).map((c) => c.line));
  const creatable = new Set(preview.accountsToCreate.map((a) => a.name));
  const excluded = preview.dateRange?.excluded ?? 0;
  // Once the date order has been chosen, the backend's "confirm the dates" note is answered.
  const warnings = preview.warnings.filter(
    (w) => !(dateOrderChosen && /dates are ambiguous|dates could be/i.test(w)),
  );
  const parts = [
    `${plan.importing.length} to import`,
    plan.alreadyThere ? `${plan.alreadyThere} already there` : null,
    plan.leftOut ? `${plan.leftOut} left out` : null,
    plan.unplaced ? `${plan.unplaced} with no account` : null,
  ].filter(Boolean);

  const badge = (line: number, decision: string, accountName: string | null) => {
    let label = 'New';
    let tone: BadgeTone = 'income';
    if (skipped.has(line)) [label, tone] = ['Left out', 'neutral'];
    else if (decision === 'already_imported' || decision === 'existing')
      [label, tone] = ['Already in', 'neutral'];
    else if (candidates.has(line))
      [label, tone] =
        review.decisions[line] === 'keep' ? ['Kept', 'income'] : ['Possible duplicate', 'pending'];
    else if (decision === 'needs_account')
      [label, tone] =
        accountName && creatable.has(accountName)
          ? ['New account', 'accent']
          : ['No account', 'danger'];
    return <Badge label={label} tone={tone} />;
  };

  return (
    <Card padding="none">
      <View style={styles.summary}>
        <Text variant="bodyStrong" testID="import-counts">
          {parts.join(' · ')}
        </Text>
        {preview.dateRange && (preview.dateRange.from || preview.dateRange.to) ? (
          <Text variant="caption" tone="muted" testID="import-excluded">
            {`Only ${preview.dateRange.from ?? 'the start'} to ${preview.dateRange.to ?? 'the end'}, both days included. ${excluded} ${excluded === 1 ? 'row is' : 'rows are'} outside these dates and will not be imported.`}
          </Text>
        ) : null}
        {preview.periodStart && preview.periodEnd ? (
          <Text variant="caption" tone="muted">
            {`Statement period ${preview.periodStart} to ${preview.periodEnd}`}
          </Text>
        ) : null}
        {preview.statementCheck ? (
          <Text variant="caption" tone={preview.statementCheck.balances ? 'income' : 'pending'}>
            {preview.statementCheck.balances
              ? 'Opening balance plus these rows equals the closing balance.'
              : 'The rows do not add up to the closing balance. Check the rows before you confirm.'}
          </Text>
        ) : null}
        {warnings.map((w) => (
          <Text key={w} variant="caption" tone="pending">
            {w}
          </Text>
        ))}
        <TotalsTable totals={plan.totals} />
        {plan.totals.length > 0 ? (
          <Text variant="caption" tone="faint">
            These are the amounts as written in the file, before any transfer or refund handling.
            Compare them with the totals in the app or statement the file came from.
          </Text>
        ) : null}
      </View>
      {preview.rows.slice(0, SHOWN_ROWS).map((r) => (
        <View key={`${r.line}-${r.date}`} style={styles.row}>
          <VStack gap="xxs" flex={1}>
            <Text variant="body" numberOfLines={1}>
              {r.rawName || r.categoryName || 'No description'}
            </Text>
            <Text variant="caption" tone="muted" numberOfLines={1}>
              {[r.date, r.accountName, r.categoryName].filter(Boolean).join(' · ')}
            </Text>
          </VStack>
          <VStack gap="xxs" align="flex-end">
            <Text variant="amount" tone={r.amount < 0 ? 'default' : 'income'}>
              {formatMoney(
                r.amount,
                r.currency ?? accounts.find((a) => a.id === r.accountId)?.currency ?? 'USD',
              )}
            </Text>
            {badge(r.line, r.decision, r.accountName)}
          </VStack>
        </View>
      ))}
      {preview.rows.length > SHOWN_ROWS ? (
        <Text variant="caption" tone="faint" style={styles.more}>
          {`and ${preview.rows.length - SHOWN_ROWS} more`}
        </Text>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create((theme) => ({
  summary: { gap: theme.space.xs, padding: theme.space.lg },
  total: {
    gap: theme.space.xxs,
    padding: theme.space.sm,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceSunken,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.md,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.sm,
    borderTopWidth: theme.size.hairline,
    borderColor: theme.colors.border,
  },
  more: { padding: theme.space.lg },
}));
