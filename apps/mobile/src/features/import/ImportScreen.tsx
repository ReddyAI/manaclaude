import type { CurrencyCode } from '@manaclaude/shared';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Button } from '../../design/components/Button';
import { Card } from '../../design/components/Card';
import { SegmentedControl } from '../../design/components/Controls';
import { Banner, EmptyState, SectionHeader } from '../../design/components/Decor';
import { HStack, VStack } from '../../design/components/Layout';
import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import { isBackendReady, useBackendConfig } from '../../data/backend/config';
import { useSettings } from '../../data/settingsStore';
import { useFinance } from '../../data/store';
import { BackAction } from '../planning/BackAction';
import { CsvColumnsCard } from './CsvColumnsCard';
import { DestinationCard } from './DestinationCard';
import { ImportHistory } from './ImportHistory';
import { SavedLayouts } from './SavedLayouts';
import { planImport, requestKey } from './importFlow';
import { PreviewCard, TotalsTable } from './PreviewCard';
import { DuplicateReviewCard, ParseErrorsCard } from './ReviewCards';
import { useImportFlow } from './useImportFlow';
import { WhatToImportCard } from './WhatToImportCard';

type Tab = 'import' | 'history' | 'layouts';
const TABS = [
  { value: 'import', label: 'Import' },
  { value: 'history', label: 'History' },
  { value: 'layouts', label: 'File layouts' },
] as const;

/**
 * Import a statement or an app's history (Monefy, bank CSV, OFX, QIF, PDF).
 * Pick a file, say which dates and where each account in it goes, read the
 * preview, answer what needs an answer (date order, unreadable lines,
 * possible duplicates), then import. Nothing is saved before that last
 * press, the result can be undone, and every import is listed under History.
 */
export function ImportScreen() {
  const config = useBackendConfig();
  const data = useFinance();
  const settings = useSettings();
  const flow = useImportFlow();
  const { state } = flow;
  const { file, options, used, preview, review, busy, saved, unsure } = state;
  const [tab, setTab] = useState<Tab>('import');
  const [showColumns, setShowColumns] = useState(false);
  const [confirmUndo, setConfirmUndo] = useState(false);

  const currencies = useMemo(
    () => [
      ...new Set<CurrencyCode>([
        settings.primaryCurrency,
        settings.secondaryCurrency,
        'USD',
        'INR',
      ]),
    ],
    [settings.primaryCurrency, settings.secondaryCurrency],
  );

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

  const plan = preview ? planImport(preview, options, used, review, data.accounts) : null;
  const stale = preview !== null && requestKey(options) !== requestKey(used);
  const csv = preview && preview.sourceFormat !== 'monefy' ? preview.csv : null;
  const shownMapping = options.mapping ?? preview?.mapping ?? csv?.suggestedMapping ?? null;
  const needsMapping = preview?.status === 'needs_mapping';
  const working = busy !== null;

  const body = () => {
    if (saved) {
      const { result } = saved;
      const undone = state.undone !== null;
      return (
        <Card>
          <VStack gap="md">
            <Text variant="headline">{undone ? 'Import undone' : 'Imported'}</Text>
            {undone ? (
              <Text variant="body" tone="muted" testID="import-undone">
                {`Removed ${state.undone} ${state.undone === 1 ? 'transaction' : 'transactions'} from ${saved.fileName}. The file stays in the vault. Accounts and categories the import made are still there.`}
              </Text>
            ) : (
              <>
                <Text variant="body" tone="muted" testID="import-result">
                  {`${result.added} added, ${result.matched} already there, ${result.skipped} left out.${result.linked ? ` ${result.linked} linked as transfers.` : ''}`}
                </Text>
                {(result.warnings ?? []).map((w) => (
                  <Banner key={w} tone="pending" icon="triangle-alert">
                    <Text variant="caption" testID="import-save-warning">
                      {`${w} The rows are saved; do not import this file again.`}
                    </Text>
                  </Banner>
                ))}
                <TotalsTable totals={saved.totals} />
                {saved.totals.length === 0 ? (
                  <Text variant="caption" tone="faint">
                    The answer to the save was lost on the way, so these counts were read back from
                    your Worker. The import is listed under History.
                  </Text>
                ) : null}
              </>
            )}
            {!undone && confirmUndo ? (
              <VStack gap="xs">
                <Text variant="caption">
                  {`Remove the ${result.added} ${result.added === 1 ? 'transaction' : 'transactions'} this import added?`}
                </Text>
                <HStack gap="sm">
                  <Button
                    label="Yes, remove them"
                    size="sm"
                    variant="danger"
                    loading={busy === 'undo'}
                    onPress={() => void flow.undo()}
                    testID="import-undo-confirm"
                  />
                  <Button
                    label="Keep"
                    size="sm"
                    variant="ghost"
                    onPress={() => setConfirmUndo(false)}
                  />
                </HStack>
              </VStack>
            ) : null}
            <HStack gap="sm" wrap>
              <Button label="Back to accounts" onPress={() => router.replace('/accounts')} />
              <Button
                label="Import another"
                variant="secondary"
                onPress={() => {
                  setConfirmUndo(false);
                  flow.reset();
                }}
                testID="import-another"
              />
              {!undone && !confirmUndo ? (
                <Button
                  label="Undo this import"
                  variant="ghost"
                  onPress={() => setConfirmUndo(true)}
                  testID="import-undo"
                />
              ) : null}
            </HStack>
          </VStack>
        </Card>
      );
    }

    if (unsure) {
      return (
        <Card>
          <VStack gap="md" testID="import-unsure">
            <Text variant="headline">
              {unsure.state === 'saving' ? 'Still saving' : 'Not sure this was saved'}
            </Text>
            <Text variant="body" tone="muted">
              {unsure.state === 'saving'
                ? `Your Worker says the import of ${unsure.fileName} is being saved, or a save was cut off part way. A cut-off save keeps nothing. Check again in a minute. If it still says this after five minutes, nothing was saved and you can import again.`
                : `The connection dropped while ${unsure.fileName} was being saved, and your Worker can't be reached to ask. Do not import the file again yet: check first, so nothing is added twice.`}
            </Text>
            <HStack gap="sm" wrap>
              <Button
                label="Check again"
                loading={busy === 'check'}
                onPress={() => void flow.check(unsure.importId, unsure.fileName)}
                testID="import-check"
              />
              {unsure.state === 'saving' && preview?.importId === unsure.importId ? (
                <Button
                  label="Try saving again"
                  variant="secondary"
                  loading={busy === 'save'}
                  onPress={() => void flow.save()}
                  testID="import-retry"
                />
              ) : null}
              <Button label="Start over" variant="ghost" onPress={flow.reset} />
            </HStack>
          </VStack>
        </Card>
      );
    }

    return (
      <>
        <SectionHeader title="1. File" />
        <Card>
          <VStack gap="md">
            <Text variant="body">
              {file ? file.name : 'Monefy or bank CSV, OFX, QFX, QIF or PDF'}
            </Text>
            <HStack gap="sm">
              <Button
                label={file ? 'Pick another' : 'Pick a file'}
                icon="file-up"
                variant={file ? 'secondary' : 'primary'}
                loading={busy === 'pick'}
                onPress={() => void flow.pick()}
                testID="import-pick"
              />
            </HStack>
          </VStack>
        </Card>

        {file ? (
          <>
            <SectionHeader title="2. Dates and how to read the file" />
            <WhatToImportCard
              options={options}
              used={used}
              preview={preview}
              fileSpan={state.fileSpan}
              currencies={currencies}
              onChange={flow.setOptions}
            />

            <SectionHeader title="3. Where it goes" />
            <DestinationCard
              options={options}
              preview={preview}
              accounts={data.accounts}
              currencies={currencies}
              manualAccounts={state.manualAccounts}
              creating={busy === 'account'}
              pendingAccount={state.pendingAccount}
              onChange={flow.setOptions}
              onCreateAccount={flow.createAccount}
              onRetryAccount={() => void flow.retryAccount()}
              onForgetAccount={() => void flow.forgetAccount()}
            />

            {csv && shownMapping ? (
              needsMapping || showColumns ? (
                <>
                  <SectionHeader title="Columns in the file" />
                  {needsMapping ? (
                    <Text variant="caption" tone="pending">
                      The columns could not be worked out. Choose which hold the date, the
                      description and the money.
                    </Text>
                  ) : null}
                  <CsvColumnsCard
                    csv={csv}
                    mapping={shownMapping}
                    options={options}
                    onChange={flow.setOptions}
                  />
                </>
              ) : (
                <HStack gap="sm" align="center" wrap>
                  {state.savedLayout ? (
                    <Text variant="caption" tone="faint" testID="import-saved-layout">
                      Read with the column layout saved from an earlier file of this bank.
                    </Text>
                  ) : null}
                  <Button
                    label="Change the columns or skip lines at the top"
                    size="sm"
                    variant="ghost"
                    icon="sliders-horizontal"
                    onPress={() => setShowColumns(true)}
                    testID="import-show-columns"
                  />
                </HStack>
              )
            ) : null}

            <HStack gap="sm" align="center" wrap>
              <Button
                label={preview ? 'Update the preview' : 'Show the preview'}
                variant={preview && !stale ? 'secondary' : 'primary'}
                loading={busy === 'preview'}
                disabled={working && busy !== 'preview'}
                onPress={() => void flow.loadPreview()}
                testID="import-preview"
              />
              {stale ? (
                <Text variant="caption" tone="pending" testID="import-stale">
                  The choices changed. The preview below is the old one.
                </Text>
              ) : null}
            </HStack>
          </>
        ) : null}

        {preview && plan && !needsMapping ? (
          <>
            <SectionHeader title="4. Preview" />
            <PreviewCard
              preview={preview}
              plan={plan}
              options={options}
              review={review}
              accounts={data.accounts}
              dateOrderChosen={used.dayFirst !== null || used.mapping !== null}
              onLeaveOut={flow.leaveOut}
              onPutRowsBack={flow.putRowsBack}
            />
            <ParseErrorsCard preview={preview} review={review} onChange={flow.setReview} />
            <DuplicateReviewCard
              preview={preview}
              review={review}
              accounts={data.accounts}
              transactions={data.transactions}
              onDecide={flow.decide}
            />
            {plan.blockers.length > 0 ? (
              <Card tone="sunken">
                <VStack gap="xs" testID="import-blockers">
                  <Text variant="label" tone="muted">
                    Before you can import
                  </Text>
                  {plan.blockers.map((b) => (
                    <Text key={b} variant="caption" tone="pending">
                      {b}
                    </Text>
                  ))}
                </VStack>
              </Card>
            ) : null}
            <HStack gap="sm">
              <Button
                label={
                  plan.importing.length > 0
                    ? `Import ${plan.importing.length} ${plan.importing.length === 1 ? 'row' : 'rows'}`
                    : 'Nothing to import'
                }
                disabled={plan.blockers.length > 0 || (working && busy !== 'save')}
                loading={busy === 'save'}
                onPress={() => void flow.save()}
                testID="import-confirm"
              />
              <Button label="Cancel" variant="ghost" onPress={flow.reset} testID="import-cancel" />
            </HStack>
          </>
        ) : null}
      </>
    );
  };

  return (
    <Screen
      title="Import a statement"
      actions={<BackAction fallback="/accounts" />}
      testID="screen-import"
    >
      <SegmentedControl
        options={TABS}
        value={tab}
        onChange={setTab}
        accessibilityLabel="Import a file, see earlier imports or saved file layouts"
      />
      {tab === 'layouts' ? (
        <SavedLayouts />
      ) : tab === 'history' ? (
        <>
          <HStack gap="sm" align="center" justify="space-between" wrap>
            <Text variant="caption" tone="muted">
              Imports that were saved, undone or could not be read.
            </Text>
            <Button
              label="Stored statements"
              icon="paperclip"
              size="sm"
              variant="ghost"
              onPress={() => router.push('/vault')}
              testID="import-open-vault"
            />
          </HStack>
          <ImportHistory />
        </>
      ) : (
        <>
          <Text variant="caption" tone="muted">
            For Monefy history, India NRE and NRO statements, or any bank without a connector.
            Nothing is saved until you press Import, and an import can be undone.
          </Text>
          {state.error ? (
            <Banner tone="danger" icon="triangle-alert">
              <Text variant="caption" testID="import-error">
                {state.error}
              </Text>
            </Banner>
          ) : null}
          {state.notice ? (
            <Banner tone="accent" icon="info">
              <Text variant="caption" testID="import-notice">
                {state.notice}
              </Text>
            </Banner>
          ) : null}
          {body()}
        </>
      )}
    </Screen>
  );
}
