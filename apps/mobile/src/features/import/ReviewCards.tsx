import {
  formatMoney,
  type Account,
  type CurrencyCode,
  type ImportPreview,
  type ImportPreviewRow,
  type Transaction,
} from '@manaclaude/shared';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Button } from '../../design/components/Button';
import { Card } from '../../design/components/Card';
import { Badge, Switch } from '../../design/components/Controls';
import { HStack, VStack } from '../../design/components/Layout';
import { Text } from '../../design/components/Text';
import type { Review } from './importFlow';

const SHOWN = 40;

const SOURCE_LABEL: Record<Transaction['source'], string> = {
  connector: 'From bank sync',
  import: 'From an earlier file',
  manual: 'Entered by hand',
};

/** Lines the file reader could not understand. They are saved only as "left out", and only if you say so. */
export function ParseErrorsCard({
  preview,
  review,
  onChange,
}: {
  preview: ImportPreview;
  review: Review;
  onChange: (patch: Partial<Review>) => void;
}) {
  if (preview.errors.length === 0) return null;
  const n = preview.errors.length;
  return (
    <Card>
      <VStack gap="sm" testID="import-errors">
        <Text variant="bodyStrong">{`${n} ${n === 1 ? 'line' : 'lines'} could not be read`}</Text>
        {preview.errors.slice(0, SHOWN).map((e) => (
          <Text key={`${e.line}-${e.message}`} variant="caption" tone="pending">
            {`Line ${e.line}: ${e.message}`}
          </Text>
        ))}
        {n > SHOWN ? <Text variant="caption" tone="faint">{`and ${n - SHOWN} more`}</Text> : null}
        <HStack gap="sm" align="center" justify="space-between">
          <VStack gap="xxs" flex={1}>
            <Text variant="body">{`Leave ${n === 1 ? 'this line' : 'these lines'} out and import the rest`}</Text>
            <Text variant="caption" tone="faint">
              Off: nothing is saved until the file is fixed or the settings above read these lines.
            </Text>
          </VStack>
          <Switch
            value={review.skipErrors}
            onValueChange={(skipErrors) => onChange({ skipErrors })}
            accessibilityLabel="Leave the unreadable lines out"
            testID="import-skip-errors"
          />
        </HStack>
      </VStack>
    </Card>
  );
}

function Side({
  title,
  name,
  date,
  amount,
  currency,
  detail,
}: {
  title: string;
  name: string;
  date: string;
  amount: number;
  currency: CurrencyCode;
  detail: string | null;
}) {
  return (
    <View style={styles.side}>
      <Text variant="label" tone="muted">
        {title}
      </Text>
      <Text variant="body" numberOfLines={2}>
        {name || 'No description'}
      </Text>
      <Text variant="caption" tone="muted">
        {date}
      </Text>
      <Text variant="amount" tone={amount < 0 ? 'default' : 'income'}>
        {formatMoney(amount, currency)}
      </Text>
      {detail ? (
        <Text variant="caption" tone="faint" numberOfLines={3}>
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Rows in the file that look like something already in the account: same
 * amount, within three days. Each one is shown next to what is stored, and
 * needs an answer. Nothing is dropped or doubled without one.
 */
export function DuplicateReviewCard({
  preview,
  review,
  accounts,
  transactions,
  onDecide,
}: {
  preview: ImportPreview;
  review: Review;
  accounts: readonly Account[];
  transactions: readonly Transaction[];
  onDecide: (lines: readonly number[], decision: 'keep' | 'skip') => void;
}) {
  const candidates = preview.duplicateCandidates ?? [];
  if (candidates.length === 0) return null;
  const rows = new Map<number, ImportPreviewRow>(preview.rows.map((r) => [r.line, r]));
  const stored = new Map(transactions.map((t) => [t.id, t]));
  const lines = candidates.map((c) => c.line);
  const answered = candidates.filter((c) => review.decisions[c.line] !== undefined).length;
  return (
    <Card>
      <VStack gap="md" testID="import-duplicates">
        <VStack gap="xxs">
          <Text variant="bodyStrong">
            {`${candidates.length} possible ${candidates.length === 1 ? 'duplicate' : 'duplicates'}`}
          </Text>
          <Text variant="caption" tone="muted">
            {`Same amount, within three days of something already in the account. That does not prove they are the same purchase, so each needs your answer. ${answered} of ${candidates.length} answered.`}
          </Text>
        </VStack>
        {candidates.length > 1 ? (
          <HStack gap="sm" wrap>
            <Button
              label="Keep all as separate"
              size="sm"
              variant="secondary"
              onPress={() => onDecide(lines, 'keep')}
              testID="import-keep-all"
            />
            <Button
              label="Skip all from the file"
              size="sm"
              variant="secondary"
              onPress={() => onDecide(lines, 'skip')}
              testID="import-skip-all"
            />
          </HStack>
        ) : null}
        {candidates.map((c) => {
          const row = rows.get(c.line);
          if (!row) return null;
          const account = accounts.find((a) => a.id === row.accountId);
          const currency = row.currency ?? account?.currency ?? 'USD';
          const decision = review.decisions[c.line];
          const matches = c.transactionIds.map((id) => stored.get(id));
          return (
            <View key={c.line} style={styles.pair} testID={`import-duplicate-${c.line}`}>
              <HStack gap="sm" align="flex-start">
                <Side
                  title={`In the file, line ${row.line}`}
                  name={row.rawName}
                  date={row.date}
                  amount={row.amount}
                  currency={currency}
                  detail={[row.categoryName, row.notes].filter(Boolean).join(' · ') || null}
                />
                <VStack gap="sm" flex={1}>
                  {matches.map((t, i) =>
                    t ? (
                      <Side
                        key={t.id}
                        title={`Already in ${account?.name ?? 'the account'}`}
                        name={t.rawName}
                        date={t.date}
                        amount={t.amount}
                        currency={t.currency}
                        detail={[SOURCE_LABEL[t.source], t.pending ? 'Pending' : null, t.notes]
                          .filter(Boolean)
                          .join(' · ')}
                      />
                    ) : (
                      <View key={c.transactionIds[i]} style={styles.side}>
                        <Text variant="label" tone="muted">
                          {`Already in ${account?.name ?? 'the account'}`}
                        </Text>
                        <Text variant="caption" tone="faint">
                          Loading its details. Pull to refresh if this stays.
                        </Text>
                      </View>
                    ),
                  )}
                </VStack>
              </HStack>
              <HStack gap="sm" wrap align="center">
                <Button
                  label="Keep both"
                  size="sm"
                  variant={decision === 'keep' ? 'primary' : 'secondary'}
                  onPress={() => onDecide([c.line], 'keep')}
                  testID={`import-keep-${c.line}`}
                />
                <Button
                  label="Skip the file's row"
                  size="sm"
                  variant={decision === 'skip' ? 'primary' : 'secondary'}
                  onPress={() => onDecide([c.line], 'skip')}
                  testID={`import-skip-${c.line}`}
                />
                <Badge
                  label={
                    decision === 'keep'
                      ? 'Will be added'
                      : decision === 'skip'
                        ? 'Will be left out'
                        : 'Needs an answer'
                  }
                  tone={decision ? 'neutral' : 'pending'}
                />
              </HStack>
            </View>
          );
        })}
      </VStack>
    </Card>
  );
}

const styles = StyleSheet.create((theme) => ({
  pair: {
    gap: theme.space.sm,
    paddingTop: theme.space.md,
    borderTopWidth: theme.size.hairline,
    borderColor: theme.colors.border,
  },
  side: {
    flex: 1,
    gap: theme.space.xxs,
    padding: theme.space.sm,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceSunken,
  },
}));
