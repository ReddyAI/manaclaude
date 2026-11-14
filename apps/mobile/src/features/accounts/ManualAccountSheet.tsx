import { useEffect, useRef, useState } from 'react';
import type { ManualAccountRequest } from '@manaclaude/shared';
import { BottomSheet } from '../../design/components/BottomSheet';
import { Button } from '../../design/components/Button';
import { HStack, VStack } from '../../design/components/Layout';
import { Text } from '../../design/components/Text';
import { haptic } from '../../design/haptics';
import { BackendError, errorText, isSuperseded } from '../../data/backend/client';
import { isBackendReady, useBackendConfig } from '../../data/backend/config';
import { useBackendStatus } from '../../data/backend/status';
import { canSaveToBackend } from '../../data/backend/sync';
import { useFinanceSelector } from '../../data/store';
import { NewAccountForm, type ManualAccountDetails } from '../import/NewAccountForm';
import { newCreationKey } from '../import/pendingAccount';
import { createAccountByHand } from './actions';
import { currencyChoices } from './cashAccount';
import {
  BY_HAND_TYPES,
  byHandOutcome,
  clearByHand,
  readByHand,
  rememberByHand,
} from './manualAccount';

type Stage =
  | { kind: 'form'; problem: string | null }
  | { kind: 'made'; name: string; replayed: boolean }
  | { kind: 'unsure'; request: ManualAccountRequest; problem: string | null }
  | { kind: 'conflict'; request: ManualAccountRequest; problem: string };

/**
 * A new account kept by hand (POST /v1/accounts/manual): a house or car with
 * its value, a loan, an NRE or NRO account, anything no connector reaches.
 * The balance is known or unknown, never assumed to be zero.
 */
export function ManualAccountSheet({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const config = useBackendConfig();
  const ready = isBackendReady(config);
  useBackendStatus();
  const accounts = useFinanceSelector((d) => d.accounts);
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<Stage>({ kind: 'form', problem: null });
  const [busy, setBusy] = useState(false);
  // Set at once on a tap, so two quick taps send one request.
  const sending = useRef(false);
  if (visible !== open) {
    setOpen(visible);
    if (visible) setStage({ kind: 'form', problem: null });
  }

  // A request whose answer was never seen, for this backend: offer the same one again.
  useEffect(() => {
    if (!visible || !ready) return;
    let alive = true;
    void readByHand().then((request) => {
      if (alive && request) setStage({ kind: 'unsure', request, problem: null });
    });
    return () => {
      alive = false;
    };
  }, [visible, ready, config.scope]);

  const live = ready && canSaveToBackend();

  const send = async (request: ManualAccountRequest) => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    try {
      const { account, replayed } = await createAccountByHand(request);
      await clearByHand();
      haptic('confirm');
      setStage({ kind: 'made', name: account.name, replayed });
    } catch (e) {
      if (isSuperseded(e)) return;
      const status = e instanceof BackendError ? e.status : 0;
      const outcome = byHandOutcome(status);
      if (outcome === 'unsure') {
        setStage({ kind: 'unsure', request, problem: errorText(e) });
      } else if (outcome === 'conflict') {
        setStage({ kind: 'conflict', request, problem: errorText(e) });
      } else {
        await clearByHand();
        haptic('reject');
        setStage({ kind: 'form', problem: errorText(e) });
      }
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  const create = async (details: ManualAccountDetails) => {
    if (sending.current) return;
    const request: ManualAccountRequest = { idempotencyKey: newCreationKey(), ...details };
    await rememberByHand(request);
    await send(request);
  };

  const forget = async () => {
    await clearByHand();
    setStage({ kind: 'form', problem: null });
  };

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title="Add an account by hand"
      scrollable
      testID="manual-account-sheet"
    >
      {!ready ? (
        <Text variant="body" tone="muted" testID="manual-account-no-backend">
          Accounts are kept by your Worker. Enter its address and your API token in Settings,
          Backend.
        </Text>
      ) : !live ? (
        <Text variant="body" tone="muted" testID="manual-account-not-loaded">
          Your data from this backend has not loaded yet. Pull down on Accounts to load it, then try
          again.
        </Text>
      ) : stage.kind === 'made' ? (
        <VStack gap="md">
          <Text variant="body" testID="manual-account-made">
            {stage.replayed
              ? `"${stage.name}" had already been made by your first try. No second account was made. It is on the Accounts tab.`
              : `"${stage.name}" is ready. It is on the Accounts tab.`}
          </Text>
          <Button label="Done" onPress={onClose} testID="manual-account-done" />
        </VStack>
      ) : stage.kind === 'unsure' ? (
        <VStack gap="md" testID="manual-account-unsure">
          <Text variant="body">
            {`The Worker didn't answer whether "${stage.request.name}" was made. It may exist already. Try again sends the same request, so the Worker answers with that account if it was made, and never makes a second one.`}
          </Text>
          {stage.problem ? (
            <Text variant="caption" tone="danger" testID="manual-account-problem">
              {stage.problem}
            </Text>
          ) : null}
          <HStack gap="sm" wrap>
            <Button
              label="Try again"
              loading={busy}
              onPress={() => void send(stage.request)}
              testID="manual-account-retry"
            />
            <Button
              label="Forget it"
              variant="ghost"
              disabled={busy}
              onPress={() => void forget()}
              testID="manual-account-forget"
            />
          </HStack>
          <Text variant="caption" tone="muted">
            Forget it only after checking the Accounts tab: a new account made after that is a
            separate one.
          </Text>
        </VStack>
      ) : stage.kind === 'conflict' ? (
        <VStack gap="md" testID="manual-account-conflict">
          <Text variant="caption" tone="danger" testID="manual-account-problem">
            {stage.problem}
          </Text>
          <Text variant="body">
            {`Check the Accounts tab for "${stage.request.name}" before making it again. The app will not send this request again.`}
          </Text>
          <Button
            label="Start over"
            variant="secondary"
            onPress={() => void forget()}
            testID="manual-account-forget"
          />
        </VStack>
      ) : (
        <VStack gap="md">
          <Text variant="caption" tone="muted">
            {
              "For a house, a car, a loan, an NRE or NRO account, or anything else no connector reaches. You update its balance or value yourself from the account's page."
            }
          </Text>
          {stage.problem ? (
            <Text variant="caption" tone="danger" testID="manual-account-problem">
              {stage.problem}
            </Text>
          ) : null}
          <NewAccountForm
            currencies={currencyChoices(accounts)}
            busy={busy}
            types={BY_HAND_TYPES}
            onCreate={(details) => void create(details)}
            onCancel={onClose}
          />
        </VStack>
      )}
    </BottomSheet>
  );
}
