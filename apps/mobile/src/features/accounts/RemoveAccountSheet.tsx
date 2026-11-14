import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { classifyAccountType, type AccountDeletionPreview } from '@manaclaude/shared';
import { BottomSheet } from '../../design/components/BottomSheet';
import { Button } from '../../design/components/Button';
import { HStack, VStack } from '../../design/components/Layout';
import { Text } from '../../design/components/Text';
import { haptic } from '../../design/haptics';
import { BackendError, errorText, isSuperseded } from '../../data/backend/client';
import { useBackendConfig } from '../../data/backend/config';
import { isBalanceUnknown } from '../../data/manualBalance';
import { useFinanceSelector } from '../../data/store';
import { Amount } from '../currency/Amount';
import { KIND_LABEL } from './accountEdit';
import { blockerText, quickCashText, removalEffects } from './accountRemoval';
import {
  deleteAccountOnWorker,
  getAccountDetail,
  getDeletionPreview,
  removeAccountFromData,
} from './actions';

/**
 * Removing an account with no connection. The deletion preview is read from
 * the Worker and shown in full: the account and its balance, every blocker
 * with what to do first, every count, and which cash account takes quick
 * entries afterwards. DELETE sends the token of the preview on screen and
 * nothing else. When the Worker says the account changed (409), the new
 * preview is shown and the removal must be confirmed again; a new token is
 * never used to delete without that.
 */

type Phase = 'loading' | 'preview' | 'deleting' | 'load-failed' | 'unsure' | 'gone';

export function RemoveAccountSheet({
  accountId,
  visible,
  onClose,
  onRemoved,
}: {
  accountId: string;
  visible: boolean;
  onClose: () => void;
  /** The Worker no longer has the account. `note` says what happened, in plain words. */
  onRemoved: (note: string) => void;
}) {
  const config = useBackendConfig();
  const accounts = useFinanceSelector((d) => d.accounts);
  const [shownKey, setShownKey] = useState('');
  const [phase, setPhase] = useState<Phase>('loading');
  const [preview, setPreview] = useState<AccountDeletionPreview | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const busy = useRef(false);
  // The opening answers belong to; one for an earlier opening is dropped.
  const session = useRef('');

  const key = visible ? `${accountId}|${config.scope}` : '';
  if (key !== shownKey) {
    setShownKey(key);
    setPreview(null);
    setNotice(null);
    setProblem(null);
    setPhase('loading');
  }

  const read = async (note: string | null = null) => {
    const mine = session.current;
    try {
      const res = await getDeletionPreview(accountId);
      if (mine !== session.current) return;
      setPreview(res);
      setNotice(note);
      setProblem(null);
      setPhase('preview');
    } catch (e) {
      if (mine !== session.current || isSuperseded(e)) return;
      if (e instanceof BackendError && e.status === 404) {
        setPhase('gone');
        return;
      }
      setProblem(errorText(e));
      setPhase('load-failed');
    }
  };
  const load = (note: string | null = null) => {
    setPhase('loading');
    setPreview(null);
    return read(note);
  };

  const opened = useEffectEvent((k: string) => {
    session.current = k;
    busy.current = false;
    // Started from a callback, so the first answer sets state after this effect.
    if (k) void Promise.resolve().then(() => read());
  });
  useEffect(() => opened(key), [key]);

  const removed = (note: string, defaultCash?: AccountDeletionPreview['defaultCash']) => {
    removeAccountFromData(accountId, defaultCash);
    onRemoved(note);
  };

  /** After a lost answer: is the account still there? Nothing is sent again by itself. */
  const checkAfterLost = async () => {
    const mine = session.current;
    setPhase('loading');
    try {
      await getAccountDetail(accountId);
      if (mine !== session.current) return;
      await load(
        "Your Worker's answer was lost, and the account is still there, so it was not removed. Read the details again and confirm if you still want to remove it.",
      );
    } catch (e) {
      if (mine !== session.current || isSuperseded(e)) return;
      if (e instanceof BackendError && e.status === 404) {
        removed(
          "Removed. Your Worker's answer was lost, but the account is gone. Pull down on Accounts to see where quick cash entries go now.",
        );
        return;
      }
      setProblem(errorText(e));
      setPhase('unsure');
    }
  };

  const confirm = async () => {
    if (!preview?.allowed || busy.current || phase !== 'preview') return;
    busy.current = true;
    const mine = session.current;
    const shown = preview;
    setPhase('deleting');
    setProblem(null);
    try {
      const res = await deleteAccountOnWorker(accountId, shown.previewToken);
      if (mine !== session.current) return;
      haptic('confirm');
      const cash = quickCashText(res.defaultCash, shown.account, accounts, 'after');
      removed(`Removed "${shown.account.name}".${cash ? ` ${cash}` : ''}`, res.defaultCash);
    } catch (e) {
      if (mine !== session.current || isSuperseded(e)) return;
      haptic('reject');
      if (e instanceof BackendError && e.status === 409 && e.code === 'account_changed') {
        await load(
          'Something about this account changed after you looked, so nothing was removed. Below is what your Worker has now. Read it again and confirm if you still want to remove it.',
        );
      } else if (
        e instanceof BackendError &&
        e.status === 409 &&
        e.code === 'account_delete_refused'
      ) {
        await load(
          'Your Worker refused, because something now stops this removal. Nothing was removed. The reasons are below.',
        );
      } else if (e instanceof BackendError && e.status === 404) {
        removed('This account was already gone from your Worker.');
      } else if (e instanceof BackendError && (e.offline || e.status >= 500)) {
        await checkAfterLost();
      } else {
        setProblem(errorText(e));
        setPhase('preview');
      }
    } finally {
      if (mine === session.current) busy.current = false;
    }
  };

  const account = preview?.account;
  const liability = account ? classifyAccountType(account.type) === 'liability' : false;
  const cashLine =
    preview && account ? quickCashText(preview.defaultCash, account, accounts) : null;

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title="Remove account"
      scrollable
      testID="remove-account-sheet"
    >
      {phase === 'loading' ? (
        <Text variant="body" tone="muted" testID="remove-loading">
          Asking your Worker what removing this account would do...
        </Text>
      ) : phase === 'gone' ? (
        <VStack gap="md">
          <Text variant="body" testID="remove-gone">
            This account is no longer on your Worker.
          </Text>
          <Button
            label="Close"
            variant="secondary"
            onPress={() => removed('This account is no longer on your Worker.')}
          />
        </VStack>
      ) : phase === 'load-failed' ? (
        <VStack gap="md">
          <Text variant="body" tone="danger" testID="remove-load-failed">
            {`Your Worker could not say what removing this account would do, so nothing can be removed yet. ${problem ?? ''}`}
          </Text>
          <Button label="Try again" variant="secondary" onPress={() => void load()} />
        </VStack>
      ) : phase === 'unsure' ? (
        <VStack gap="md">
          <Text variant="body" tone="danger" testID="remove-unsure">
            {`Your Worker did not answer, so it is not known whether the account was removed. Check before doing anything else. ${problem ?? ''}`}
          </Text>
          <Button
            label="Check again"
            variant="secondary"
            onPress={() => void checkAfterLost()}
            testID="remove-check"
          />
        </VStack>
      ) : preview && account ? (
        <VStack gap="md">
          {notice ? (
            <Text variant="body" tone="pending" testID="remove-notice">
              {notice}
            </Text>
          ) : null}
          <VStack gap="xxs">
            <Text variant="bodyStrong" testID="remove-account-name">
              {account.name}
            </Text>
            <Text variant="caption" tone="muted">
              {`${KIND_LABEL[account.type]} · ${account.currency}`}
            </Text>
            <HStack gap="xs" align="center">
              <Text variant="caption" tone="muted">
                {liability ? 'Owed:' : 'Balance:'}
              </Text>
              {isBalanceUnknown(account) ? (
                <Text variant="caption" testID="remove-balance-unknown">
                  Unknown
                </Text>
              ) : (
                <Amount
                  amount={liability ? -account.balance : account.balance}
                  currency={account.currency}
                  size="small"
                  testID="remove-balance"
                />
              )}
            </HStack>
          </VStack>

          {preview.allowed ? (
            <VStack gap="xs" testID="remove-effects">
              {removalEffects(preview).map((line) => (
                <Text key={line} variant="body">
                  {line}
                </Text>
              ))}
              {!isBalanceUnknown(account) && account.balance !== 0 ? (
                <Text variant="body" tone="pending" testID="remove-nonzero">
                  Its balance is not zero. It stops counting anywhere once the account is removed.
                </Text>
              ) : null}
              {cashLine ? (
                <Text variant="body" testID="remove-cash">
                  {cashLine}
                </Text>
              ) : null}
            </VStack>
          ) : (
            <VStack gap="sm" testID="remove-blocked">
              <Text variant="bodyStrong">{"This account can't be removed yet."}</Text>
              {preview.blockers.map((b) => {
                const t = blockerText(b, preview);
                return (
                  <VStack key={b} gap="xxs" testID={`remove-blocker-${b}`}>
                    <Text variant="body">{t.what}</Text>
                    <Text variant="caption" tone="muted">
                      {t.todo}
                    </Text>
                  </VStack>
                );
              })}
            </VStack>
          )}

          {problem ? (
            <Text variant="caption" tone="danger" testID="remove-problem">
              {problem}
            </Text>
          ) : null}
          <HStack gap="sm" wrap>
            {preview.allowed ? (
              <Button
                label={`Remove "${account.name}"`}
                variant="danger"
                loading={phase === 'deleting'}
                onPress={() => void confirm()}
                testID="remove-confirm"
              />
            ) : (
              <Button
                label="Check again"
                variant="secondary"
                onPress={() => void load()}
                testID="remove-recheck"
              />
            )}
            <Button label="Keep it" variant="secondary" onPress={onClose} />
          </HStack>
        </VStack>
      ) : null}
    </BottomSheet>
  );
}
