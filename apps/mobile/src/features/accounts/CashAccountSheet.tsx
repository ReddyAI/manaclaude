import { useRef, useState } from 'react';
import { BottomSheet } from '../../design/components/BottomSheet';
import { Button } from '../../design/components/Button';
import { Chip, Switch, TextField } from '../../design/components/Controls';
import { HStack, VStack } from '../../design/components/Layout';
import { Text } from '../../design/components/Text';
import { haptic } from '../../design/haptics';
import { BackendError, errorText, isSuperseded } from '../../data/backend/client';
import { isBackendReady, useBackendConfig } from '../../data/backend/config';
import { useBackendStatus } from '../../data/backend/status';
import { canSaveToBackend } from '../../data/backend/sync';
import { useFinanceSelector } from '../../data/store';
import { createCashAccount } from './actions';
import {
  CASH_NAME_MAX,
  checkCashAccount,
  currencyChoices,
  defaultCashFor,
  type CashAccountDraft,
} from './cashAccount';

const EMPTY: CashAccountDraft = { name: '', currency: 'INR', balance: '', isDefault: true };

/** A new cash account on the Worker (POST /v1/accounts/cash). */
export function CashAccountSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const ready = isBackendReady(useBackendConfig());
  useBackendStatus();
  const accounts = useFinanceSelector((d) => d.accounts);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<CashAccountDraft>(EMPTY);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);
  // Set at once on a tap: the route has no retry key, so a second tap would make a second account.
  const sending = useRef(false);
  if (visible !== open) {
    setOpen(visible);
    if (visible) {
      setDraft(EMPTY);
      setTried(false);
      setProblem(null);
      setMade(null);
    }
  }

  // The current-default check reads this backend's accounts, so its data must be on screen.
  const live = ready && canSaveToBackend();
  const check = checkCashAccount(draft, accounts);
  const existingDefault = defaultCashFor(accounts, draft.currency);
  const set = (patch: Partial<CashAccountDraft>) => setDraft({ ...draft, ...patch });

  const save = async () => {
    setTried(true);
    if (!check.body || !live || sending.current) return;
    sending.current = true;
    setBusy(true);
    setProblem(null);
    try {
      const account = await createCashAccount(check.body);
      haptic('confirm');
      setMade(account.name);
    } catch (e) {
      if (isSuperseded(e)) return;
      setProblem(
        e instanceof BackendError && (e.offline || e.status >= 500)
          ? `${errorText(e)} The account may have been made all the same. Pull down on Accounts to check before trying again.`
          : errorText(e),
      );
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title="Add a cash account"
      scrollable
      testID="cash-account-sheet"
    >
      {!ready ? (
        <Text variant="body" tone="muted" testID="cash-account-no-backend">
          Cash accounts are kept by your Worker. Enter its address and your API token in Settings,
          Backend.
        </Text>
      ) : !live ? (
        <Text variant="body" tone="muted" testID="cash-account-not-loaded">
          Your data from this backend has not loaded yet. Pull down on Accounts to load it, then try
          again.
        </Text>
      ) : made ? (
        <VStack gap="md">
          <Text variant="body" testID="cash-account-made">
            {`"${made}" is ready. It is listed under Cash on the Accounts tab.`}
          </Text>
          <Button label="Done" onPress={onClose} testID="cash-account-done" />
        </VStack>
      ) : (
        <VStack gap="md">
          <TextField
            label="Name"
            value={draft.name}
            onChangeText={(name) => set({ name })}
            placeholder="Wallet"
            maxLength={CASH_NAME_MAX + 20}
            error={tried || draft.name ? check.problems.name : undefined}
            testID="cash-account-name"
          />
          <VStack gap="xs">
            <Text variant="label" tone="muted">
              Currency
            </Text>
            <HStack gap="xs" wrap>
              {currencyChoices(accounts).map((c) => (
                <Chip
                  key={c}
                  label={c}
                  selected={draft.currency === c}
                  onPress={() => set({ currency: c })}
                  testID={`cash-account-currency-${c}`}
                />
              ))}
            </HStack>
          </VStack>
          <TextField
            label={`Cash on hand now (${draft.currency})`}
            value={draft.balance}
            onChangeText={(balance) => set({ balance })}
            keyboardType="decimal-pad"
            placeholder="0"
            error={tried ? check.problems.balance : undefined}
            testID="cash-account-balance"
          />
          {existingDefault ? (
            <Text variant="caption" tone="muted" testID="cash-account-has-default">
              {`Quick cash entries in ${draft.currency} go to "${existingDefault.name}". The Worker has no way yet to move them to a new account, so this one is not offered for that.`}
            </Text>
          ) : (
            <HStack gap="md" align="center" justify="space-between">
              <VStack gap="xxs" flex={1}>
                <Text variant="bodyStrong">{`Use for quick cash entries in ${draft.currency}`}</Text>
                <Text variant="caption" tone="muted">
                  The quick cash button on Home, Transactions and Accounts adds cash here.
                </Text>
              </VStack>
              <Switch
                value={draft.isDefault}
                onValueChange={(isDefault) => set({ isDefault })}
                accessibilityLabel={`Use for quick cash entries in ${draft.currency}`}
                testID="cash-account-default"
              />
            </HStack>
          )}
          {problem ? (
            <Text variant="caption" tone="danger" testID="cash-account-problem">
              {problem}
            </Text>
          ) : null}
          <Button
            label="Add"
            loading={busy}
            onPress={() => void save()}
            testID="cash-account-save"
          />
        </VStack>
      )}
    </BottomSheet>
  );
}
