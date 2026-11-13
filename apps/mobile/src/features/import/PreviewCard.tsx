import { formatMoney, type Account, type ImportPreview } from '@manaclaude/shared';
import { useState } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Button } from '../../design/components/Button';
import { Card } from '../../design/components/Card';
import { Badge, type BadgeTone } from '../../design/components/Controls';
import { Icon } from '../../design/components/Icon';
import { HStack, VStack } from '../../design/components/Layout';
import { PressableScale } from '../../design/components/PressableScale';
import { Text } from '../../design/components/Text';
import {
  commitLines,
  rowChoices,
  type ImportOptions,
  type ImportPlan,
  type Review,
  type TotalLine,
} from './importFlow';

/** Rows listed at first, and how many each "show more" adds. A long file is not drawn all at once. */
const SHOWN_ROWS = 60;
const MORE_ROWS = 100;

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

/** "3 left out", and what they are when unreadable lines are among them: the same number the save reports. */
export function leftOutText(
  plan: Pick<ImportPlan, 'leftOut' | 'unreadableLeftOut'>,
): string | null {
  const total = plan.leftOut + plan.unreadableLeftOut;
  if (total === 0) return null;
  if (plan.unreadableLeftOut === 0) return `${total} left out`;
  const rows = `${plan.leftOut} ${plan.leftOut === 1 ? 'row' : 'rows'}`;
  const lines = `${plan.unreadableLeftOut} unreadable ${plan.unreadableLeftOut === 1 ? 'line' : 'lines'}`;
  return `${total} left out (${plan.leftOut > 0 ? `${rows}, ` : ''}${lines})`;
}

/**
 * What a save would do: the counts, the totals to compare, the backend's
 * notes and the rows. Each row that is not settled elsewhere has a tick box:
 * untick it to leave that one row out.
 */
export function PreviewCard({
  preview,
  plan,
  options,
  review,
  accounts,
  dateOrderChosen,
  onLeaveOut,
  onPutRowsBack,
}: {
  preview: ImportPreview;
  plan: ImportPlan;
  /** The preview was made with a date order picked by hand. */
  dateOrderChosen: boolean;
  options: ImportOptions;
  review: Review;
  accounts: readonly Account[];
  /** Leave one row out (true) or put it back (false). */
  onLeaveOut: (line: number, out: boolean) => void;
  onPutRowsBack: () => void;
}) {
  const [shown, setShown] = useState(SHOWN_ROWS);
  const skipped = new Set(commitLines(preview, options, review).skipLines);
  const choices = rowChoices(preview, options, review);
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
    leftOutText(plan),
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
        {choices.size > 0 ? (
          <HStack gap="sm" align="center" justify="space-between" wrap>
            <Text
              variant="caption"
              tone="muted"
              style={styles.hint}
              testID="import-left-out-by-hand"
            >
              {plan.leftOutByHand > 0
                ? `${plan.leftOutByHand} ${plan.leftOutByHand === 1 ? 'row' : 'rows'} left out by you. The counts and totals above are without ${plan.leftOutByHand === 1 ? 'it' : 'them'}.`
                : 'Untick a row to leave it out. The counts and totals above follow.'}
            </Text>
            {plan.leftOutByHand > 0 ? (
              <Button
                label={plan.leftOutByHand === 1 ? 'Put it back' : 'Put them back'}
                size="sm"
                variant="ghost"
                onPress={onPutRowsBack}
                testID="import-put-rows-back"
              />
            ) : null}
          </HStack>
        ) : null}
      </View>
      {preview.rows.slice(0, shown).map((r) => {
        const choice = choices.get(r.line);
        const name = r.rawName || r.categoryName || 'No description';
        const out = skipped.has(r.line);
        return (
          <View key={`${r.line}-${r.date}`} style={styles.row} testID={`import-row-${r.line}`}>
            {choice ? (
              <PressableScale
                onPress={() => onLeaveOut(r.line, choice === 'in')}
                pressHaptic="tap"
                accessibilityRole="checkbox"
                accessibilityState={{ checked: choice === 'in' }}
                // The web build reads the state from this one.
                aria-checked={choice === 'in'}
                accessibilityLabel={`Import line ${r.line}: ${name}`}
                style={styles.tickArea}
                testID={`import-row-tick-${r.line}`}
              >
                <View style={styles.tick(choice === 'in')}>
                  {choice === 'in' ? <Icon name="check" size="xs" tone="onAccent" /> : null}
                </View>
              </PressableScale>
            ) : choices.size > 0 ? (
              <View style={styles.tickArea} />
            ) : null}
            <VStack gap="xxs" flex={1}>
              <Text variant="body" tone={out ? 'muted' : 'default'} numberOfLines={1}>
                {name}
              </Text>
              <Text variant="caption" tone="muted" numberOfLines={1}>
                {[r.date, r.accountName, r.categoryName].filter(Boolean).join(' · ')}
              </Text>
            </VStack>
            <VStack gap="xxs" align="flex-end">
              <Text variant="amount" tone={out ? 'muted' : r.amount < 0 ? 'default' : 'income'}>
                {formatMoney(
                  r.amount,
                  r.currency ?? accounts.find((a) => a.id === r.accountId)?.currency ?? 'USD',
                )}
              </Text>
              {badge(r.line, r.decision, r.accountName)}
            </VStack>
          </View>
        );
      })}
      {preview.rows.length > shown ? (
        <HStack gap="sm" align="center" justify="space-between" wrap style={styles.more}>
          <Text variant="caption" tone="faint" testID="import-rows-shown">
            {`Showing ${shown} of ${preview.rows.length} rows. The counts and totals are for all of them.`}
          </Text>
          <Button
            label={`Show ${Math.min(MORE_ROWS, preview.rows.length - shown)} more`}
            size="sm"
            variant="secondary"
            onPress={() => setShown(shown + MORE_ROWS)}
            testID="import-more-rows"
          />
        </HStack>
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
  hint: { flex: 1 },
  tickArea: {
    width: theme.size.touchTarget,
    minHeight: theme.size.touchTarget,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  tick: (on: boolean) => ({
    width: theme.size.iconMd,
    height: theme.size.iconMd,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.sm,
    borderWidth: theme.size.borderWidth,
    borderColor: on ? theme.colors.accent : theme.colors.borderStrong,
    backgroundColor: on ? theme.colors.accent : theme.colors.surface,
  }),
}));
