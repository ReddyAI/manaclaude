import {
  addMonthsToMonth,
  firstDayOfMonth,
  formatMonthShort,
  lastDayOfMonth,
  monthOf,
  type CurrencyCode,
  type ImportPreview,
} from '@manaclaude/shared';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Card } from '../../design/components/Card';
import { Chip, TextField } from '../../design/components/Controls';
import { Banner } from '../../design/components/Decor';
import { HStack, VStack } from '../../design/components/Layout';
import { Text } from '../../design/components/Text';
import { dateProblem, needsDateConfirmation, rowSpan, type ImportOptions } from './importFlow';
import { dateFormatLabel } from './labels';

const QUICK_MONTHS = 6;

/**
 * Which part of the file to import and how to read it: the dates (both
 * included), the date order when it can be read two ways, and the currency
 * for files that do not say.
 */
export function WhatToImportCard({
  options,
  used,
  preview,
  fileSpan,
  currencies,
  onChange,
}: {
  options: ImportOptions;
  used: ImportOptions;
  preview: ImportPreview | null;
  /** First and last date in the whole file, once a preview without date limits has shown them. */
  fileSpan: { first: string; last: string } | null;
  currencies: readonly CurrencyCode[];
  onChange: (patch: Partial<ImportOptions>) => void;
}) {
  const problem = dateProblem(options);
  const months: string[] = [];
  if (fileSpan) {
    const firstMonth = monthOf(fileSpan.first);
    for (let m = monthOf(fileSpan.last); m >= firstMonth && months.length < QUICK_MONTHS;) {
      months.push(m);
      m = addMonthsToMonth(m, -1);
    }
  }
  const monthSelected = (m: string) =>
    options.fromDate === firstDayOfMonth(m) && options.toDate === lastDayOfMonth(m);

  const monefyOrQif = preview?.sourceFormat === 'monefy' || preview?.format === 'qif';
  const csv = preview && preview.sourceFormat !== 'monefy' ? preview.csv : null;
  const shownMapping = options.mapping ?? preview?.mapping ?? csv?.suggestedMapping ?? null;
  const confirm = preview ? needsDateConfirmation(preview, used) : false;
  const span = preview ? rowSpan(preview.rows) : null;
  // The file has no currency of its own and no destination says which: ask.
  const asksCurrency =
    !options.accountId &&
    (preview === null || (preview.format === 'qif' && preview.rows.some((r) => !r.accountId)));

  return (
    <Card>
      <VStack gap="md">
        <VStack gap="xs">
          <Text variant="label" tone="muted">
            Dates to import (both days included)
          </Text>
          <HStack gap="sm">
            <View style={styles.half}>
              <TextField
                label="From"
                value={options.fromDate}
                onChangeText={(fromDate) => onChange({ fromDate: fromDate.trim() })}
                placeholder="YYYY-MM-DD"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="numbers-and-punctuation"
                testID="import-from"
              />
            </View>
            <View style={styles.half}>
              <TextField
                label="To"
                value={options.toDate}
                onChangeText={(toDate) => onChange({ toDate: toDate.trim() })}
                placeholder="YYYY-MM-DD"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="numbers-and-punctuation"
                testID="import-to"
              />
            </View>
          </HStack>
          {problem ? (
            <Text variant="caption" tone="danger" testID="import-date-problem">
              {problem}
            </Text>
          ) : null}
          <HStack gap="xs" wrap>
            <Chip
              label="All dates"
              selected={!options.fromDate && !options.toDate}
              onPress={() => onChange({ fromDate: '', toDate: '' })}
              testID="import-all-dates"
            />
            {months.map((m) => (
              <Chip
                key={m}
                label={`${formatMonthShort(m)} ${m.slice(0, 4)}`}
                selected={monthSelected(m)}
                onPress={() =>
                  onChange({ fromDate: firstDayOfMonth(m), toDate: lastDayOfMonth(m) })
                }
                testID={`import-month-${m}`}
              />
            ))}
          </HStack>
          {fileSpan ? (
            <Text variant="caption" tone="faint">
              {`The file runs from ${fileSpan.first} to ${fileSpan.last}.`}
            </Text>
          ) : (
            <Text variant="caption" tone="faint">
              Leave both empty to read the whole file. Start with one month to check the totals.
            </Text>
          )}
        </VStack>

        {preview && preview.status !== 'needs_mapping' && (monefyOrQif || csv) ? (
          <VStack gap="xs">
            <Text variant="label" tone="muted">
              How dates are written in the file
            </Text>
            {confirm ? (
              <Banner tone="pending" icon="triangle-alert">
                <Text variant="caption" testID="import-date-confirm">
                  The dates in this file can be read two ways (3 April or 4 March). Choose the one
                  that matches the file. Nothing is saved until you do.
                </Text>
              </Banner>
            ) : null}
            {monefyOrQif ? (
              <HStack gap="xs" wrap>
                <Chip
                  label="Day first (31/12/2026)"
                  selected={options.dayFirst === true}
                  onPress={() => onChange({ dayFirst: true })}
                  testID="import-day-first"
                />
                <Chip
                  label="Month first (12/31/2026)"
                  selected={options.dayFirst === false}
                  onPress={() => onChange({ dayFirst: false })}
                  testID="import-month-first"
                />
              </HStack>
            ) : csv && shownMapping ? (
              <HStack gap="xs" wrap>
                {(csv.dateFormatCandidates.length > 0
                  ? csv.dateFormatCandidates
                  : [shownMapping.dateFormat]
                ).map((f) => (
                  <Chip
                    key={f}
                    label={dateFormatLabel(f)}
                    selected={
                      options.mapping?.dateFormat === f ||
                      (!confirm && shownMapping.dateFormat === f)
                    }
                    onPress={() => onChange({ mapping: { ...shownMapping, dateFormat: f } })}
                    testID={`import-date-format-${f}`}
                  />
                ))}
              </HStack>
            ) : null}
            {span ? (
              <Text variant="caption" tone="faint">
                {`Read this way, the rows shown run from ${span.first} to ${span.last}.`}
              </Text>
            ) : null}
          </VStack>
        ) : null}

        {asksCurrency ? (
          <VStack gap="xs">
            <Text variant="label" tone="muted">
              Currency, if the file does not say
            </Text>
            <HStack gap="xs" wrap>
              <Chip
                label="From the account"
                selected={options.currency === null}
                onPress={() => onChange({ currency: null })}
              />
              {currencies.map((c) => (
                <Chip
                  key={c}
                  label={c}
                  selected={options.currency === c}
                  onPress={() => onChange({ currency: c })}
                  testID={`import-currency-${c}`}
                />
              ))}
            </HStack>
            <Text variant="caption" tone="faint">
              Importing never converts money. An amount is saved in the currency it was written in.
            </Text>
          </VStack>
        ) : null}
      </VStack>
    </Card>
  );
}

const styles = StyleSheet.create(() => ({
  half: { flex: 1 },
}));
