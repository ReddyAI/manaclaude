import {
  MANUAL_ACCOUNT_TYPES,
  type CurrencyCode,
  type ManualAccountRequest,
  type ManualAccountType,
} from '@manaclaude/shared';
import { useState } from 'react';
import { Button } from '../../design/components/Button';
import { Chip, TextField } from '../../design/components/Controls';
import { HStack, VStack } from '../../design/components/Layout';
import { Text } from '../../design/components/Text';
import { ACCOUNT_TYPE_LABEL } from './labels';

/** Name, type, currency and last four digits of a bank account made by hand for a statement. */
export function NewAccountForm({
  currencies,
  busy,
  onCreate,
  onCancel,
}: {
  currencies: readonly CurrencyCode[];
  busy: boolean;
  onCreate: (input: ManualAccountRequest) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<ManualAccountType>('savings');
  const [currency, setCurrency] = useState<CurrencyCode | null>(null);
  const [mask, setMask] = useState('');
  const maskOk = mask === '' || /^\d{1,4}$/.test(mask);
  const ready = name.trim().length > 0 && currency !== null && maskOk;
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
        {MANUAL_ACCOUNT_TYPES.map((t) => (
          <Chip
            key={t}
            label={ACCOUNT_TYPE_LABEL[t]}
            selected={type === t}
            onPress={() => setType(t)}
            testID={`new-account-type-${t}`}
          />
        ))}
      </HStack>
      <Text variant="label" tone="muted">
        Currency
      </Text>
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
      <TextField
        label="Last four digits (optional)"
        value={mask}
        onChangeText={(t) => setMask(t.trim())}
        placeholder="1234"
        keyboardType="number-pad"
        maxLength={4}
        error={maskOk ? undefined : 'Digits only, four at most.'}
        testID="new-account-mask"
      />
      <Text variant="caption" tone="faint">
        The account starts with a balance of zero. The full account number is never stored.
      </Text>
      <HStack gap="sm">
        <Button
          label="Make this account"
          size="sm"
          disabled={!ready}
          loading={busy}
          onPress={() => {
            if (!ready || currency === null) return;
            onCreate({ name: name.trim(), type, currency, ...(mask ? { mask } : {}) });
          }}
          testID="new-account-create"
        />
        <Button label="Cancel" size="sm" variant="ghost" onPress={onCancel} />
      </HStack>
    </VStack>
  );
}
