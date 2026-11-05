import {
  formatMoney,
  type CsvMapping,
  type ImportCommitResult,
  type ImportPreview,
} from '@manaclaude/shared';
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Button } from '../../design/components/Button';
import { Card } from '../../design/components/Card';
import { Badge, Chip } from '../../design/components/Controls';
import { Banner, EmptyState, SectionHeader } from '../../design/components/Decor';
import { HStack, VStack } from '../../design/components/Layout';
import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import { haptic } from '../../design/haptics';
import { errorText } from '../../data/backend/client';
import { isBackendReady, useBackendConfig } from '../../data/backend/config';
import { refreshDataset } from '../../data/backend/sync';
import { useFinance } from '../../data/store';
import { BackAction } from '../planning/BackAction';
import { commitImport, discardImport, previewImport, type PickedFile } from './importApi';
import { pickStatementFile } from './pickFile';

const DECISION: Record<
  string,
  { label: string; tone: 'income' | 'neutral' | 'pending' | 'accent' }
> = {
  new: { label: 'New', tone: 'income' },
  already_imported: { label: 'Already in', tone: 'neutral' },
  existing: { label: 'Matches one', tone: 'neutral' },
  needs_account: { label: 'New account', tone: 'pending' },
};
const SHOWN_ROWS = 60;

/**
 * Import a statement (session E2): India NRE and NRO accounts have no
 * connector, so their statements come in as files. Pick a CSV, OFX, QIF or PDF,
 * choose the account, look at the preview, confirm. Rows already imported or
 * already synced are left out; the original file stays in the statement vault.
 */
export function ImportScreen() {
  const config = useBackendConfig();
  const data = useFinance();
  const [file, setFile] = useState<PickedFile | null>(null);
  const [accountId, setAccountId] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<CsvMapping | null>(null);
  const [result, setResult] = useState<ImportCommitResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Accounts that get statements: banks, cards, loans and brokerages (not cash, crypto, property or vehicles).
  const accounts = data.accounts.filter(
    (a) =>
      !a.hidden &&
      [
        'checking',
        'savings',
        'credit_card',
        'loan',
        'mortgage',
        'brokerage',
        'retirement',
      ].includes(a.type),
  );

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const pick = () =>
    run(async () => {
      const picked = await pickStatementFile();
      if (!picked) return;
      setFile(picked);
      setPreview(null);
      setMapping(null);
      setResult(null);
    });

  const load = (m?: CsvMapping) =>
    run(async () => {
      if (!file) return;
      const p = await previewImport(file, { accountId, mapping: m ?? mapping ?? undefined });
      setPreview(p);
      setMapping(p.mapping ?? p.csv?.suggestedMapping ?? null);
    });

  const confirm = () =>
    run(async () => {
      if (!preview) return;
      const r = await commitImport(preview.importId);
      setResult(r);
      haptic('confirm');
      await refreshDataset();
    });

  const reset = () => {
    if (preview && !result) void discardImport(preview.importId).catch(() => {});
    setFile(null);
    setPreview(null);
    setMapping(null);
    setResult(null);
  };

  if (!isBackendReady(config)) {
    return (
      <Screen
        title="Import a statement"
        actions={<BackAction fallback="/accounts" />}
        testID="screen-import"
      >
        <Card>
          <EmptyState
            icon="cloud-off"
            title="Set up the backend first"
            message="Imports are read and stored by your Worker. Enter its address and your API token in Settings, Backend."
          />
        </Card>
      </Screen>
    );
  }

  const columnChips = (label: string, key: 'dateColumn' | 'descriptionColumn' | 'amountColumn') =>
    preview?.csv && mapping ? (
      <VStack gap="xs">
        <Text variant="label" tone="muted">
          {label}
        </Text>
        <HStack gap="xs" wrap>
          {preview.csv.headers.map((h, i) => (
            <Chip
              key={`${key}-${i}`}
              label={h || `Column ${i + 1}`}
              selected={mapping[key] === i}
              onPress={() =>
                setMapping({
                  ...mapping,
                  [key]: i,
                  ...(key === 'amountColumn' ? { amountMode: 'single' as const } : {}),
                })
              }
            />
          ))}
        </HStack>
      </VStack>
    ) : null;

  return (
    <Screen
      title="Import a statement"
      actions={<BackAction fallback="/accounts" />}
      testID="screen-import"
    >
      <Text variant="caption" tone="muted">
        For India NRE and NRO accounts, or any bank without a connector. PDF statements are read by
        the AI on your Worker; CSV, OFX and QIF files are read directly.
      </Text>
      {error ? (
        <Banner tone="danger" icon="triangle-alert">
          <Text variant="caption" testID="import-error">
            {error}
          </Text>
        </Banner>
      ) : null}

      {result ? (
        <Card>
          <VStack gap="md">
            <Text variant="headline">Imported</Text>
            <Text variant="body" tone="muted" testID="import-result">
              {`${result.added} added, ${result.matched} already there, ${result.skipped} skipped.${result.linked ? ` ${result.linked} linked as transfers.` : ''}`}
            </Text>
            <HStack gap="sm">
              <Button label="Back to accounts" onPress={() => router.replace('/accounts')} />
              <Button label="Import another" variant="secondary" onPress={reset} />
            </HStack>
          </VStack>
        </Card>
      ) : (
        <>
          <SectionHeader title="1. File" />
          <Card>
            <VStack gap="md">
              <Text variant="body">{file ? file.name : 'CSV, OFX, QFX, QIF or PDF'}</Text>
              <HStack gap="sm">
                <Button
                  label={file ? 'Pick another' : 'Pick a file'}
                  icon="file-up"
                  variant={file ? 'secondary' : 'primary'}
                  onPress={pick}
                  testID="import-pick"
                />
              </HStack>
            </VStack>
          </Card>

          {file ? (
            <>
              <SectionHeader title="2. Account" />
              <Card>
                <VStack gap="sm">
                  <HStack gap="xs" wrap>
                    <Chip
                      label="From the file"
                      selected={accountId === undefined}
                      onPress={() => setAccountId(undefined)}
                    />
                    {accounts.map((a) => (
                      <Chip
                        key={a.id}
                        label={`${a.name}${a.mask ? ` ••${a.mask}` : ''}`}
                        selected={accountId === a.id}
                        onPress={() => setAccountId(a.id)}
                        testID={`import-account-${a.id}`}
                      />
                    ))}
                  </HStack>
                  <Text variant="caption" tone="faint">
                    From the file: the account number or name in the statement picks the account, or
                    a new one is made.
                  </Text>
                  <Button
                    label="Show the preview"
                    loading={busy}
                    onPress={() => void load()}
                    testID="import-preview"
                  />
                </VStack>
              </Card>
            </>
          ) : null}

          {preview ? (
            <>
              <SectionHeader title="3. Preview" />
              {preview.status === 'needs_mapping' && preview.csv ? (
                <Card>
                  <VStack gap="md">
                    <Text variant="body">
                      Choose which columns hold the date, the description and the amount.
                    </Text>
                    {columnChips('Date', 'dateColumn')}
                    {columnChips('Description', 'descriptionColumn')}
                    {columnChips('Amount', 'amountColumn')}
                    <Button
                      label="Use these columns"
                      loading={busy}
                      onPress={() => void load(mapping ?? undefined)}
                    />
                  </VStack>
                </Card>
              ) : (
                <Card padding="none">
                  <View style={styles.summary}>
                    <Text variant="bodyStrong" testID="import-counts">
                      {`${preview.counts.new} new · ${preview.counts.alreadyImported + preview.counts.existing} already there${preview.counts.needsAccount ? ` · ${preview.counts.needsAccount} for a new account` : ''}`}
                    </Text>
                    {preview.periodStart && preview.periodEnd ? (
                      <Text
                        variant="caption"
                        tone="muted"
                      >{`${preview.periodStart} to ${preview.periodEnd}`}</Text>
                    ) : null}
                    {preview.statementCheck ? (
                      <Text
                        variant="caption"
                        tone={preview.statementCheck.balances ? 'income' : 'pending'}
                      >
                        {preview.statementCheck.balances
                          ? 'Opening balance plus these rows equals the closing balance.'
                          : 'The rows do not add up to the closing balance. Check the rows before you confirm.'}
                      </Text>
                    ) : null}
                    {[
                      ...preview.warnings,
                      ...preview.errors.map((e) => `Line ${e.line}: ${e.message}`),
                    ]
                      .slice(0, 5)
                      .map((w) => (
                        <Text key={w} variant="caption" tone="pending">
                          {w}
                        </Text>
                      ))}
                  </View>
                  {preview.rows.slice(0, SHOWN_ROWS).map((r) => {
                    const d = DECISION[r.decision] ?? DECISION.new!;
                    return (
                      <View key={`${r.line}-${r.date}`} style={styles.row}>
                        <VStack gap="xxs" flex={1}>
                          <Text variant="body" numberOfLines={1}>
                            {r.rawName}
                          </Text>
                          <Text variant="caption" tone="muted">
                            {r.date}
                          </Text>
                        </VStack>
                        <VStack gap="xxs" align="flex-end">
                          <Text variant="amount" tone={r.amount < 0 ? 'default' : 'income'}>
                            {formatMoney(
                              r.amount,
                              r.currency ??
                                data.accounts.find((a) => a.id === r.accountId)?.currency ??
                                'INR',
                            )}
                          </Text>
                          <Badge label={d.label} tone={d.tone} />
                        </VStack>
                      </View>
                    );
                  })}
                  {preview.rows.length > SHOWN_ROWS ? (
                    <Text variant="caption" tone="faint" style={styles.more}>
                      {`and ${preview.rows.length - SHOWN_ROWS} more`}
                    </Text>
                  ) : null}
                </Card>
              )}
              {preview.status === 'preview' ? (
                <HStack gap="sm">
                  <Button
                    label={
                      preview.counts.new + preview.counts.needsAccount > 0
                        ? `Import ${preview.counts.new + preview.counts.needsAccount}`
                        : 'Nothing new'
                    }
                    disabled={preview.counts.new + preview.counts.needsAccount === 0}
                    loading={busy}
                    onPress={confirm}
                    testID="import-confirm"
                  />
                  <Button label="Cancel" variant="ghost" onPress={reset} />
                </HStack>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create((theme) => ({
  summary: { gap: theme.space.xs, padding: theme.space.lg },
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
