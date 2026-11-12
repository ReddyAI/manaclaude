import type {
  Account,
  CurrencyCode,
  ImportPreview,
  ManualAccountRequest,
} from '@manaclaude/shared';
import { useState } from 'react';
import { Card } from '../../design/components/Card';
import { Chip } from '../../design/components/Controls';
import { HStack, VStack, Divider } from '../../design/components/Layout';
import { Text } from '../../design/components/Text';
import { sourcesOf, type ImportOptions, type SourceChoice, type SourceInfo } from './importFlow';
import { ACCOUNT_TYPE_LABEL } from './labels';
import { NewAccountForm } from './NewAccountForm';

const accountLabel = (a: Account) => `${a.name}${a.mask ? ` ••${a.mask}` : ''}`;

/** Accounts a file can go into: everything you keep transactions in. */
export function importableAccounts(accounts: readonly Account[]): Account[] {
  return accounts.filter((a) => !a.hidden && !['property', 'vehicle', 'crypto'].includes(a.type));
}

function sourceCurrency(preview: ImportPreview, source: SourceInfo): CurrencyCode | null {
  return (
    preview.rows.find((r) => r.accountName === source.name && r.currency)?.currency ??
    source.create?.currency ??
    null
  );
}

/**
 * Where the rows go. A file that names its accounts (Monefy, QIF, OFX) gets
 * one line per account in it: an existing account, a new one from the file,
 * or left out. A file with no account in it gets one destination.
 */
export function DestinationCard({
  options,
  preview,
  accounts,
  currencies,
  manualAccounts,
  creating,
  onChange,
  onCreateAccount,
}: {
  options: ImportOptions;
  preview: ImportPreview | null;
  accounts: readonly Account[];
  currencies: readonly CurrencyCode[];
  manualAccounts: boolean;
  creating: boolean;
  onChange: (patch: Partial<ImportOptions>) => void;
  onCreateAccount: (input: ManualAccountRequest) => Promise<boolean>;
}) {
  const [adding, setAdding] = useState(false);
  const usable = importableAccounts(accounts);
  const sources = preview ? sourcesOf(preview) : [];

  if (preview && sources.length > 0) {
    const choose = (name: string, choice: SourceChoice) =>
      onChange({ sources: { ...options.sources, [name]: choice } });
    return (
      <Card>
        <VStack gap="md">
          <Text variant="caption" tone="muted">
            {sources.length === 1
              ? 'The file names one account. Choose where its rows go.'
              : `The file holds ${sources.length} accounts. Choose where each one goes.`}
          </Text>
          {sources.map((source, i) => {
            const choice = options.sources[source.name] ?? { kind: 'file' as const };
            const currency = sourceCurrency(preview, source);
            const fitting = usable.filter((a) => !currency || a.currency === currency);
            const resolved = accounts.find((a) => a.id === source.resolvedAccountId);
            const fromFile =
              choice.kind !== 'file'
                ? null
                : resolved && !options.sources[source.name]
                  ? `Goes to ${accountLabel(resolved)}, matched by its name or number.`
                  : source.create
                    ? `A new account "${source.create.name}" (${source.create.currency ?? 'USD'}, ${ACCOUNT_TYPE_LABEL[source.create.type ?? 'checking']}) will be made.${preview.sourceFormat === 'monefy' ? ' It is kept out of net worth, because the file has no balances.' : ''}`
                    : resolved
                      ? `Goes to ${accountLabel(resolved)}.`
                      : 'No account for these rows yet. Pick one of yours, or leave them out.';
            return (
              <VStack key={source.name} gap="xs" testID={`import-source-${i}`}>
                {i > 0 ? <Divider /> : null}
                <HStack gap="sm" justify="space-between">
                  <Text variant="bodyStrong" numberOfLines={1}>
                    {source.name}
                  </Text>
                  <Text variant="caption" tone="muted">
                    {`${source.rows} ${source.rows === 1 ? 'row' : 'rows'}${currency ? ` · ${currency}` : ''}`}
                  </Text>
                </HStack>
                <HStack gap="xs" wrap>
                  <Chip
                    label={source.create || !resolved ? 'New from the file' : 'As the file says'}
                    selected={choice.kind === 'file'}
                    onPress={() => choose(source.name, { kind: 'file' })}
                    testID={`import-source-${i}-file`}
                  />
                  {fitting.map((a) => (
                    <Chip
                      key={a.id}
                      label={accountLabel(a)}
                      selected={choice.kind === 'account' && choice.accountId === a.id}
                      onPress={() => choose(source.name, { kind: 'account', accountId: a.id })}
                      testID={`import-source-${i}-${a.id}`}
                    />
                  ))}
                  <Chip
                    label="Leave out"
                    selected={choice.kind === 'skip'}
                    onPress={() => choose(source.name, { kind: 'skip' })}
                    testID={`import-source-${i}-skip`}
                  />
                </HStack>
                {fromFile ? (
                  <Text variant="caption" tone="faint">
                    {fromFile}
                  </Text>
                ) : null}
                {choice.kind === 'skip' ? (
                  <Text variant="caption" tone="faint">
                    None of its rows will be imported.
                  </Text>
                ) : null}
                {currency && fitting.length < usable.length ? (
                  <Text variant="caption" tone="faint">
                    {`Only your ${currency} accounts are listed, because importing never converts money.`}
                  </Text>
                ) : null}
              </VStack>
            );
          })}
        </VStack>
      </Card>
    );
  }

  return (
    <Card>
      <VStack gap="sm">
        <HStack gap="xs" wrap>
          <Chip
            label="From the file"
            selected={options.accountId === null}
            onPress={() => onChange({ accountId: null })}
            testID="import-account-file"
          />
          {usable.map((a) => (
            <Chip
              key={a.id}
              label={accountLabel(a)}
              selected={options.accountId === a.id}
              onPress={() => onChange({ accountId: a.id, currency: null })}
              testID={`import-account-${a.id}`}
            />
          ))}
          {manualAccounts && !adding ? (
            <Chip
              label="New account"
              icon="plus"
              onPress={() => setAdding(true)}
              testID="import-account-new"
            />
          ) : null}
        </HStack>
        {adding ? (
          <NewAccountForm
            currencies={currencies}
            busy={creating}
            onCancel={() => setAdding(false)}
            onCreate={(input) => {
              void onCreateAccount(input).then((ok) => {
                if (ok) setAdding(false);
              });
            }}
          />
        ) : null}
        <Text variant="caption" tone="faint">
          {preview && preview.counts.needsAccount > 0 && options.accountId === null
            ? 'This file does not say which account it is from. Pick the account it belongs to.'
            : 'From the file: the account name or number inside the file picks the account. Statements with no account inside need one picked here.'}
        </Text>
        {!manualAccounts ? (
          <Text variant="caption" tone="faint" testID="import-no-manual-accounts">
            Making a new bank account here needs an update to your Worker that is not installed yet.
            Until then, pick one of your accounts.
          </Text>
        ) : null}
      </VStack>
    </Card>
  );
}
