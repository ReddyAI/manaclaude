import {
  classifyAccountType,
  parseAmountText,
  todayLocal,
  type CurrencyCode,
  type ManualAccountRequest,
  type ManualAccountType,
} from '@manaclaude/shared';
import { useState } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Button } from '../../design/components/Button';
import { Chip, Switch, TextField } from '../../design/components/Controls';
import { HStack, VStack } from '../../design/components/Layout';
import { Text } from '../../design/components/Text';
import { isLocalDate } from './importFlow';
import { ACCOUNT_TYPE_LABEL } from './labels';

/** What the form collects. The creation key is added when it is sent. */
export type ManualAccountDetails = Omit<ManualAccountRequest, 'idempotencyKey'>;

/** The types offered here. The Worker accepts more (crypto, property, vehicle); those are not statement accounts. */
const TYPES: readonly ManualAccountType[] = [
  'savings',
  'checking',
  'credit_card',
  'loan',
  'mortgage',
  'brokerage',
  'retirement',
  'other_asset',
  'other_liability',
];

/** Labels the app already uses for kinds of account, per type. */
const SUBTYPES: Partial<Record<ManualAccountType, readonly [value: string, label: string][]>> = {
  savings: [
    ['nre', 'NRE'],
    ['nro', 'NRO'],
    ['fcnr', 'FCNR'],
    ['fixed_deposit', 'Fixed deposit'],
    ['hysa', 'High-yield savings'],
  ],
  checking: [
    ['nre', 'NRE'],
    ['nro', 'NRO'],
  ],
  brokerage: [
    ['demat', 'Demat'],
    ['taxable', 'Taxable'],
  ],
  retirement: [
    ['401k', '401(k)'],
    ['roth_401k', 'Roth 401(k)'],
    ['ira', 'IRA'],
    ['roth_ira', 'Roth IRA'],
    ['ppf', 'PPF'],
    ['epf', 'EPF'],
    ['nps', 'NPS'],
  ],
  loan: [
    ['auto_loan', 'Auto loan'],
    ['student_loan', 'Student loan'],
    ['personal_loan', 'Personal loan'],
  ],
};

/** Noon UTC on the day given, so the calendar date reads the same in India and the US. */
const asOfFor = (date: string) => `${date}T12:00:00.000Z`;

/**
 * A bank account made by hand as the home of a statement. It asks plainly
 * whether today's balance is known: unknown is saved as unknown, not as
 * zero, and no balance is ever worked out from the rows of a file.
 */
export function NewAccountForm({
  currencies,
  busy,
  initialName = '',
  fixedCurrency = null,
  types = TYPES,
  onCreate,
  onCancel,
}: {
  currencies: readonly CurrencyCode[];
  busy: boolean;
  initialName?: string;
  /** The file's rows are in this currency, so the account must be too. */
  fixedCurrency?: CurrencyCode | null;
  /** The types offered, first one chosen. Statement accounts when left out. */
  types?: readonly ManualAccountType[];
  onCreate: (details: ManualAccountDetails) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [type, setType] = useState<ManualAccountType>(types[0] ?? 'savings');
  const [subtype, setSubtype] = useState<string | null>(null);
  const [currency, setCurrency] = useState<CurrencyCode | null>(fixedCurrency);
  const [known, setKnown] = useState<boolean | null>(null);
  const [balance, setBalance] = useState('');
  const [balanceDate, setBalanceDate] = useState(todayLocal());
  const [inNetWorth, setInNetWorth] = useState(true);
  const [hasOpening, setHasOpening] = useState(false);
  const [opening, setOpening] = useState('');
  const [openingDate, setOpeningDate] = useState('');

  const liability = classifyAccountType(type) === 'liability';
  // Property and vehicles have a value rather than a balance.
  const valued = type === 'property' || type === 'vehicle';
  const amountLabel = liability ? 'Amount owed' : valued ? 'Value' : 'Balance';
  const parse = (text: string) => (currency ? parseAmountText(text, currency) : null);
  const balanceAmount = parse(balance);
  const openingAmount = parse(opening);

  const problems: string[] = [];
  if (!name.trim()) problems.push('Give the account a name.');
  if (!currency) problems.push('Choose the currency.');
  if (known === null) problems.push('Say whether you know the balance today.');
  if (known) {
    if (balanceAmount === null)
      problems.push(`Enter the ${amountLabel.toLowerCase()} as a number.`);
    if (!isLocalDate(balanceDate)) problems.push('Write the balance date as YYYY-MM-DD.');
  }
  if (hasOpening) {
    if (openingAmount === null) problems.push('Enter the opening balance as a number.');
    if (!isLocalDate(openingDate)) problems.push('Write the opening date as YYYY-MM-DD.');
    else if (known && isLocalDate(balanceDate) && openingDate > balanceDate)
      problems.push("The opening date can't be after the date of today's balance.");
  }
  const ready = problems.length === 0;

  const submit = () => {
    if (!ready || !currency || known === null) return;
    const details: ManualAccountDetails = {
      name: name.trim(),
      type,
      currency,
      currentBalance:
        known && balanceAmount !== null
          ? { amount: balanceAmount, asOf: asOfFor(balanceDate) }
          : null,
    };
    if (subtype) details.subtype = subtype;
    if (hasOpening && openingAmount !== null)
      details.openingBalance = { amount: openingAmount, date: openingDate };
    if (known && !inNetWorth) details.includeInNetWorth = false;
    onCreate(details);
  };

  const subtypes = SUBTYPES[type] ?? [];
  return (
    <VStack gap="sm" testID="import-new-account">
      <TextField
        label="Account name"
        value={name}
        onChangeText={setName}
        placeholder="For example NRE Savings"
        maxLength={100}
        testID="new-account-name"
      />
      <Text variant="label" tone="muted">
        Type
      </Text>
      <HStack gap="xs" wrap>
        {types.map((t) => (
          <Chip
            key={t}
            label={ACCOUNT_TYPE_LABEL[t]}
            selected={type === t}
            onPress={() => {
              setType(t);
              setSubtype(null);
            }}
            testID={`new-account-type-${t}`}
          />
        ))}
      </HStack>
      {subtypes.length > 0 ? (
        <>
          <Text variant="label" tone="muted">
            Kind (optional)
          </Text>
          <HStack gap="xs" wrap>
            <Chip label="None" selected={subtype === null} onPress={() => setSubtype(null)} />
            {subtypes.map(([value, label]) => (
              <Chip
                key={value}
                label={label}
                selected={subtype === value}
                onPress={() => setSubtype(value)}
                testID={`new-account-subtype-${value}`}
              />
            ))}
          </HStack>
        </>
      ) : null}
      <Text variant="label" tone="muted">
        Currency
      </Text>
      {fixedCurrency ? (
        <Text variant="caption" tone="faint">
          {`${fixedCurrency}, because the rows in the file are in ${fixedCurrency}.`}
        </Text>
      ) : (
        <HStack gap="xs" wrap>
          {currencies.map((c) => (
            <Chip
              key={c}
              label={c}
              selected={currency === c}
              onPress={() => setCurrency(c)}
              testID={`new-account-currency-${c}`}
            />
          ))}
        </HStack>
      )}

      <Text variant="label" tone="muted">
        {liability
          ? 'Do you know what is owed today?'
          : valued
            ? 'Do you know what it is worth today?'
            : 'Do you know the balance today?'}
      </Text>
      <HStack gap="xs" wrap>
        <Chip
          label="I don't know it"
          selected={known === false}
          onPress={() => setKnown(false)}
          testID="new-account-balance-unknown"
        />
        <Chip
          label="I know it"
          selected={known === true}
          onPress={() => setKnown(true)}
          testID="new-account-balance-known"
        />
      </HStack>
      {known === false ? (
        <Text variant="caption" tone="faint">
          The balance will show as unknown, not as zero, and the account stays out of net worth.
          Importing a file never works a balance out for you.
        </Text>
      ) : null}
      {known ? (
        <>
          <HStack gap="sm">
            <View style={styles.half}>
              <TextField
                label={amountLabel}
                value={balance}
                onChangeText={setBalance}
                placeholder="0.00"
                keyboardType="numbers-and-punctuation"
                testID="new-account-balance"
              />
            </View>
            <View style={styles.half}>
              <TextField
                label="On this date"
                value={balanceDate}
                onChangeText={(t) => setBalanceDate(t.trim())}
                placeholder="YYYY-MM-DD"
                autoCapitalize="none"
                keyboardType="numbers-and-punctuation"
                testID="new-account-balance-date"
              />
            </View>
          </HStack>
          {liability ? (
            <Text variant="caption" tone="faint">
              Enter what you owe as a positive number.
            </Text>
          ) : null}
          <HStack gap="sm" align="center" justify="space-between">
            <Text variant="body">Count it in net worth</Text>
            <Switch
              value={inNetWorth}
              onValueChange={setInNetWorth}
              accessibilityLabel="Count this account in net worth"
              testID="new-account-net-worth"
            />
          </HStack>
        </>
      ) : null}

      <HStack gap="sm" align="center" justify="space-between">
        <VStack gap="xxs" flex={1}>
          <Text variant="body">Add an opening balance (optional)</Text>
          <Text variant="caption" tone="faint">
            A balance you know from the past. It is kept as a reading, never as income or spending.
          </Text>
        </VStack>
        <Switch
          value={hasOpening}
          onValueChange={setHasOpening}
          accessibilityLabel="Add an opening balance"
          testID="new-account-has-opening"
        />
      </HStack>
      {hasOpening ? (
        <HStack gap="sm">
          <View style={styles.half}>
            <TextField
              label={liability ? 'Owed then' : 'Balance then'}
              value={opening}
              onChangeText={setOpening}
              placeholder="0.00"
              keyboardType="numbers-and-punctuation"
              testID="new-account-opening"
            />
          </View>
          <View style={styles.half}>
            <TextField
              label="On this date"
              value={openingDate}
              onChangeText={(t) => setOpeningDate(t.trim())}
              placeholder="YYYY-MM-DD"
              autoCapitalize="none"
              keyboardType="numbers-and-punctuation"
              testID="new-account-opening-date"
            />
          </View>
        </HStack>
      ) : null}

      {problems.length > 0 ? (
        <Text variant="caption" tone="pending" testID="new-account-problem">
          {problems[0]}
        </Text>
      ) : null}
      <HStack gap="sm">
        <Button
          label="Make this account"
          size="sm"
          disabled={!ready}
          loading={busy}
          onPress={submit}
          testID="new-account-create"
        />
        <Button label="Cancel" size="sm" variant="ghost" onPress={onCancel} />
      </HStack>
    </VStack>
  );
}

const styles = StyleSheet.create(() => ({
  half: { flex: 1 },
}));
