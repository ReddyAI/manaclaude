import { DATE_FORMATS, type CsvMapping, type CsvPreviewInfo } from '@manaclaude/shared';
import { Button } from '../../design/components/Button';
import { Card } from '../../design/components/Card';
import { Chip, Switch } from '../../design/components/Controls';
import { HStack, VStack } from '../../design/components/Layout';
import { Text } from '../../design/components/Text';
import type { ImportOptions } from './importFlow';
import { dateFormatLabel } from './labels';

const MAX_PREAMBLE = 30;

type ColumnKey =
  'dateColumn' | 'descriptionColumn' | 'amountColumn' | 'debitColumn' | 'creditColumn';

/**
 * How a bank's CSV is laid out: lines above the header, whether there is a
 * header, which columns hold the date, the description and the money (one
 * signed column, or separate money-out and money-in columns).
 */
export function CsvColumnsCard({
  csv,
  mapping,
  options,
  onChange,
}: {
  csv: CsvPreviewInfo;
  /** The mapping on screen: chosen by hand, else the saved or suggested one. */
  mapping: CsvMapping;
  options: ImportOptions;
  onChange: (patch: Partial<ImportOptions>) => void;
}) {
  const set = (patch: Partial<CsvMapping>) => onChange({ mapping: { ...mapping, ...patch } });
  const preamble = options.mapping?.skipRows ?? options.skipRows ?? mapping.skipRows;
  // Moving the header changes what every column is, so the columns are guessed again.
  const setPreamble = (n: number) =>
    onChange({ mapping: null, skipRows: Math.max(0, Math.min(MAX_PREAMBLE, n)) });

  const columns = (label: string, key: ColumnKey, testID: string) => (
    <VStack gap="xs">
      <Text variant="label" tone="muted">
        {label}
      </Text>
      <HStack gap="xs" wrap>
        {csv.headers.map((h, i) => (
          <Chip
            key={`${key}-${i}`}
            label={h || `Column ${i + 1}`}
            selected={mapping[key] === i}
            onPress={() => set({ [key]: i })}
            testID={`${testID}-${i}`}
          />
        ))}
      </HStack>
    </VStack>
  );

  return (
    <Card>
      <VStack gap="md" testID="import-columns">
        <VStack gap="xs">
          <Text variant="label" tone="muted">
            Lines above the column names (bank name, address, account details)
          </Text>
          <HStack gap="sm" align="center">
            <Button
              label="Fewer"
              size="sm"
              variant="secondary"
              disabled={preamble <= 0}
              onPress={() => setPreamble(preamble - 1)}
              testID="import-preamble-less"
            />
            <Text variant="bodyStrong" testID="import-preamble">
              {String(preamble)}
            </Text>
            <Button
              label="More"
              size="sm"
              variant="secondary"
              disabled={preamble >= MAX_PREAMBLE}
              onPress={() => setPreamble(preamble + 1)}
              testID="import-preamble-more"
            />
          </HStack>
          <Text variant="caption" tone="faint">
            {`The line now read as the column names: ${csv.headers.filter(Boolean).join(', ') || 'empty'}`}
          </Text>
        </VStack>

        <HStack gap="sm" align="center" justify="space-between">
          <Text variant="body">That line holds column names, not a transaction</Text>
          <Switch
            value={mapping.hasHeader}
            onValueChange={(hasHeader) => set({ hasHeader })}
            accessibilityLabel="The first line holds column names"
            testID="import-has-header"
          />
        </HStack>

        {columns('Date column', 'dateColumn', 'import-col-date')}
        <VStack gap="xs">
          <Text variant="label" tone="muted">
            How the dates are written
          </Text>
          <HStack gap="xs" wrap>
            {DATE_FORMATS.map((f) => (
              <Chip
                key={f}
                label={dateFormatLabel(f)}
                selected={mapping.dateFormat === f}
                onPress={() => set({ dateFormat: f })}
                testID={`import-col-dateformat-${f}`}
              />
            ))}
          </HStack>
        </VStack>
        {columns('Description column', 'descriptionColumn', 'import-col-description')}

        <VStack gap="xs">
          <Text variant="label" tone="muted">
            Money
          </Text>
          <HStack gap="xs" wrap>
            <Chip
              label="One amount column"
              selected={mapping.amountMode === 'single'}
              onPress={() =>
                set({
                  amountMode: 'single',
                  amountColumn: mapping.amountColumn ?? mapping.debitColumn ?? 0,
                  debitColumn: null,
                  creditColumn: null,
                })
              }
              testID="import-amount-single"
            />
            <Chip
              label="Separate debit and credit columns"
              selected={mapping.amountMode === 'debit_credit'}
              onPress={() =>
                set({
                  amountMode: 'debit_credit',
                  debitColumn: mapping.debitColumn ?? mapping.amountColumn ?? 0,
                  creditColumn: mapping.creditColumn ?? mapping.amountColumn ?? 0,
                  amountColumn: null,
                  invertSign: false,
                })
              }
              testID="import-amount-split"
            />
          </HStack>
        </VStack>
        {mapping.amountMode === 'single' ? (
          <>
            {columns('Amount column', 'amountColumn', 'import-col-amount')}
            <HStack gap="sm" align="center" justify="space-between">
              <Text variant="body">Money going out is written as a positive number</Text>
              <Switch
                value={mapping.invertSign}
                onValueChange={(invertSign) => set({ invertSign })}
                accessibilityLabel="Flip the sign of every amount"
                testID="import-invert-sign"
              />
            </HStack>
          </>
        ) : (
          <>
            {columns('Debit column (money out)', 'debitColumn', 'import-col-debit')}
            {columns('Credit column (money in)', 'creditColumn', 'import-col-credit')}
            {mapping.debitColumn === mapping.creditColumn ? (
              <Text variant="caption" tone="danger">
                Debit and credit need two different columns.
              </Text>
            ) : null}
          </>
        )}
      </VStack>
    </Card>
  );
}
