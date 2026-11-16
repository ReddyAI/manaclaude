import { useMemo, useState } from 'react';
import {
  type Account,
  type AccountHistory,
  type Transaction,
  type YearMonth,
} from '@manaclaude/shared';
import { StyleSheet } from 'react-native-unistyles';
import { View } from 'react-native';
import { Button } from '../../design/components/Button';
import { Card } from '../../design/components/Card';
import { Chip, SegmentedControl, TextField } from '../../design/components/Controls';
import { HStack, VStack } from '../../design/components/Layout';
import { Text } from '../../design/components/Text';
import {
  EMPTY_ACCOUNT,
  isRealDate,
  monthCounts,
  monthLabel,
  periodText,
  selectableMonths,
  type AccountDraft,
  type AccountMode,
} from './historyModel';

const SHOWN = 12;

/**
 * One connected bank or card account: whether it follows the cutoff above,
 * has its own, or keeps Monefy for every date; which whole months before the
 * cutoff the bank replaces (with how many entries each source has there);
 * and the periods the Worker has for it.
 */
export function AccountSourceCard({
  account,
  draft,
  defaultCutoff,
  transactions,
  history,
  onChange,
}: {
  account: Account;
  draft: AccountDraft | undefined;
  defaultCutoff: string;
  transactions: readonly Transaction[];
  /** The Worker's periods: from the last check if there is one, else as saved. */
  history: AccountHistory | undefined;
  onChange: (patch: Partial<AccountDraft>) => void;
}) {
  const a = draft ?? EMPTY_ACCOUNT;
  const [shown, setShown] = useState(SHOWN);
  const cutoff = a.mode === 'custom' ? a.cutoff.trim() : defaultCutoff.trim();
  const counts = useMemo(() => monthCounts(transactions, account.id), [transactions, account.id]);
  const months = useMemo(() => {
    if (!isRealDate(cutoff)) return [];
    const earliest = counts[counts.length - 1]?.month ?? null;
    return selectableMonths(cutoff, earliest);
  }, [counts, cutoff]);
  const byMonth = useMemo(() => new Map(counts.map((c) => [c.month, c])), [counts]);
  const chosen = new Set(a.months);

  const toggle = (m: YearMonth) =>
    onChange({
      months: chosen.has(m) ? a.months.filter((x) => x !== m) : [...a.months, m],
    });

  return (
    <Card>
      <VStack gap="sm" testID={`history-account-${account.id}`}>
        <VStack gap="xxs">
          <Text variant="bodyStrong">{account.name}</Text>
          {account.institutionName ? (
            <Text variant="caption" tone="muted">
              {account.institutionName}
            </Text>
          ) : null}
        </VStack>
        <SegmentedControl<AccountMode>
          accessibilityLabel={`${account.name}: history source`}
          value={a.mode}
          onChange={(mode) => onChange({ mode })}
          options={[
            { value: 'default', label: 'Cutoff above' },
            { value: 'custom', label: 'Own cutoff' },
            { value: 'monefy_only', label: 'Monefy only' },
          ]}
        />
        {a.mode === 'monefy_only' ? (
          <Text variant="caption" tone="muted" testID={`history-monefy-only-${account.id}`}>
            {`Monefy is this account's history on every date, and no bank transaction is saved for it.`}
          </Text>
        ) : null}
        {a.mode === 'custom' ? (
          <TextField
            label="This account's first bank day (YYYY-MM-DD)"
            value={a.cutoff}
            onChangeText={(cutoffText) => onChange({ cutoff: cutoffText })}
            autoCapitalize="none"
            testID={`history-cutoff-${account.id}`}
          />
        ) : null}
        {a.mode !== 'monefy_only' ? (
          <VStack gap="xs">
            <Text variant="label" tone="muted">
              {a.months.length > 0
                ? `Months the bank replaces: ${a.months.length}`
                : 'Months the bank replaces: none'}
            </Text>
            {months.length === 0 ? (
              <Text variant="caption" tone="muted">
                Enter a cutoff first; the months before it can then be given to the bank.
              </Text>
            ) : (
              <View style={styles.months}>
                {months.slice(0, shown).map((m) => {
                  const c = byMonth.get(m);
                  const label = `${monthLabel(m)} · ${c?.monefy ?? 0} Monefy · ${c?.bank ?? 0} bank`;
                  return (
                    <Chip
                      key={m}
                      label={label}
                      selected={chosen.has(m)}
                      onPress={() => toggle(m)}
                      accessibilityLabel={`${label}. ${chosen.has(m) ? 'The bank replaces this month.' : 'Monefy keeps this month.'}`}
                      testID={`history-month-${account.id}-${m}`}
                    />
                  );
                })}
              </View>
            )}
            {months.length > shown ? (
              <HStack>
                <Button
                  label="Show older months"
                  size="sm"
                  variant="ghost"
                  onPress={() => setShown((n) => n + SHOWN)}
                  testID={`history-older-${account.id}`}
                />
              </HStack>
            ) : null}
            {a.months.some((m) => !months.includes(m)) ? (
              <Text variant="caption" tone="pending">
                {`Some chosen months are not before this cutoff's month: ${a.months
                  .filter((m) => !months.includes(m))
                  .map(monthLabel)
                  .join(', ')}. Untick them or move the cutoff.`}
              </Text>
            ) : null}
          </VStack>
        ) : null}
        {history ? (
          <VStack gap="xxs" testID={`history-periods-${account.id}`}>
            {history.periods.map((p, i) => (
              <Text key={`${p.source}-${p.from ?? ''}-${i}`} variant="caption" tone="muted">
                {periodText(p)}
              </Text>
            ))}
            {history.coverage.status === 'unavailable' ? (
              <Text variant="caption" tone="pending" testID={`history-unavailable-${account.id}`}>
                {`Its connection is disconnected or needs repair, so bank history can't be fetched for it now.`}
              </Text>
            ) : null}
          </VStack>
        ) : null}
      </VStack>
    </Card>
  );
}

const styles = StyleSheet.create((theme) => ({
  months: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.xs },
}));
