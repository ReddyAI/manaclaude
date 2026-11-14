import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { Account, AccountDetailResponse } from '@manaclaude/shared';
import { BottomSheet } from '../../design/components/BottomSheet';
import { Button } from '../../design/components/Button';
import { Chip, SegmentedControl, Switch, TextField } from '../../design/components/Controls';
import { HStack, VStack } from '../../design/components/Layout';
import { Text } from '../../design/components/Text';
import { haptic } from '../../design/haptics';
import { BackendError, errorText, isSuperseded } from '../../data/backend/client';
import { useBackendConfig } from '../../data/backend/config';
import { refreshDataset } from '../../data/backend/sync';
import { useToday } from '../../data/selectors';
import { useFinance } from '../../data/store';
import {
  ACCOUNT_NAME_MAX,
  KIND_LABEL,
  NON_CASH_KINDS,
  balanceLabel,
  checkAccountEdit,
  chooseBalance,
  draftFrom,
  isProviderAccount,
  kindLock,
  matchesEdit,
  readOnlyReason,
  type AccountDraft,
  type AccountEditBody,
} from './accountEdit';
import { getAccountDetail, patchAccount, putAccountInData } from './actions';

/**
 * Editing an account with no connection: name, kind, the current balance
 * (known with its date, or unknown) and whether it counts in net worth.
 *
 * The form is filled from GET /v1/accounts/:id and keeps that answer's
 * version token. PATCH sends only what changed with that token. When the
 * Worker says the account changed meanwhile (409 account_changed), or the
 * answer is lost, the account is read again before anything else: the form
 * then shows the Worker's values and asks for a new, deliberate save. Old
 * values are never sent again with a new token by themselves.
 */

type Phase =
  /** Reading the account from the Worker. */
  | 'loading'
  | 'form'
  | 'saving'
  | 'saved'
  /** A provider account: shown, not editable. */
  | 'readonly'
  /** The Worker no longer has this account. */
  | 'gone'
  /** The first read failed. */
  | 'load-failed'
  /** A save's answer was lost and the read after it failed too: nothing may be sent until a read works. */
  | 'unsure';

export function AccountEditSheet({
  accountId,
  visible,
  onClose,
}: {
  accountId: string;
  visible: boolean;
  onClose: () => void;
}) {
  const data = useFinance();
  const today = useToday();
  const config = useBackendConfig();
  const [shownKey, setShownKey] = useState('');
  const [phase, setPhase] = useState<Phase>('loading');
  const [detail, setDetail] = useState<AccountDetailResponse | null>(null);
  const [draft, setDraft] = useState<AccountDraft | null>(null);
  const [tried, setTried] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // The edit whose answer is not known yet, kept for the read after a lost answer.
  const pendingEdit = useRef<AccountEditBody | null>(null);
  // Set at the moment of a tap, so a fast second tap cannot send twice.
  const busy = useRef(false);
  // The opening (account and backend) answers belong to; one for an earlier opening is dropped.
  const session = useRef('');

  const show = (res: AccountDetailResponse, note: string | null) => {
    setDetail(res);
    setDraft(draftFrom(res.account, today));
    setTried(false);
    setNotice(note);
    setProblem(null);
    putAccountInData(res.account);
    setPhase(isProviderAccount(res.account) ? 'readonly' : 'form');
  };

  /** Reads the account. After a save whose result is unknown, `after` says why. */
  const read = async (after?: { edit: AccountEditBody; why: 'changed' | 'lost' }) => {
    const mine = session.current;
    try {
      const res = await getAccountDetail(accountId);
      if (mine !== session.current) return;
      if (!after) return show(res, null);
      if (matchesEdit(res.account, after.edit)) {
        pendingEdit.current = null;
        show(res, null);
        setNotice(
          after.why === 'lost'
            ? "Your Worker's answer was lost, but it has your change."
            : 'Your Worker already has this change.',
        );
        setPhase(isProviderAccount(res.account) ? 'readonly' : 'saved');
        putAccountInData(res.account, { reload: true });
        return;
      }
      pendingEdit.current = null;
      show(
        res,
        after.why === 'changed'
          ? 'This account was changed somewhere else after you opened it, so nothing was saved. The form now shows what your Worker has. Make your change again and tap Save.'
          : "Your Worker's answer was lost and it does not have your change, so nothing was saved. The form now shows what your Worker has. Make your change again and tap Save.",
      );
    } catch (e) {
      if (mine !== session.current || isSuperseded(e)) return;
      if (e instanceof BackendError && e.status === 404) {
        pendingEdit.current = null;
        setPhase('gone');
        void refreshDataset();
        return;
      }
      setProblem(errorText(e));
      setPhase(after ? 'unsure' : 'load-failed');
    }
  };
  const load = (after?: { edit: AccountEditBody; why: 'changed' | 'lost' }) => {
    setPhase('loading');
    return read(after);
  };

  // A new opening, another account or another backend starts from a fresh read.
  const key = visible ? `${accountId}|${config.scope}` : '';
  if (key !== shownKey) {
    setShownKey(key);
    setDetail(null);
    setDraft(null);
    setNotice(null);
    setProblem(null);
    setTried(false);
    setPhase('loading');
  }
  const opened = useEffectEvent((k: string) => {
    session.current = k;
    busy.current = false;
    pendingEdit.current = null;
    // Started from a callback, so the first answer sets state after this effect.
    if (k) void Promise.resolve().then(() => read());
  });
  useEffect(() => opened(key), [key]);

  const account: Account | null = detail?.account ?? null;
  const lock = account ? kindLock(account, data) : null;
  const check =
    account && draft ? checkAccountEdit(draft, account, { today, kindLock: lock }) : null;
  const set = (patch: Partial<AccountDraft>) => draft && setDraft({ ...draft, ...patch });

  const save = async () => {
    setTried(true);
    if (!detail || !check?.body || busy.current || (phase !== 'form' && phase !== 'saved')) return;
    busy.current = true;
    const mine = session.current;
    const edit = check.body;
    pendingEdit.current = edit;
    setPhase('saving');
    setProblem(null);
    setNotice(null);
    try {
      const res = await patchAccount(accountId, { expectedVersion: detail.version, ...edit });
      if (mine !== session.current) return;
      pendingEdit.current = null;
      haptic('confirm');
      setDetail(res);
      setDraft(draftFrom(res.account, today));
      setTried(false);
      setPhase('saved');
      putAccountInData(res.account, { reload: true });
    } catch (e) {
      if (mine !== session.current || isSuperseded(e)) return;
      if (e instanceof BackendError && e.status === 409 && e.code === 'account_changed') {
        await load({ edit, why: 'changed' });
      } else if (e instanceof BackendError && (e.offline || e.status >= 500)) {
        // Read again before anything else; never resend by itself.
        await load({ edit, why: 'lost' });
      } else if (e instanceof BackendError && e.status === 409 && e.code === 'account_connected') {
        pendingEdit.current = null;
        await load();
      } else if (e instanceof BackendError && e.status === 404) {
        pendingEdit.current = null;
        setPhase('gone');
        void refreshDataset();
      } else {
        pendingEdit.current = null;
        haptic('reject');
        setProblem(errorText(e));
        setPhase('form');
      }
    } finally {
      if (mine === session.current) busy.current = false;
    }
  };

  const liveCurrency = account?.currency ?? '';
  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title="Edit account"
      scrollable
      testID="account-edit-sheet"
    >
      {phase === 'loading' ? (
        <Text variant="body" tone="muted" testID="account-edit-loading">
          Reading the account from your Worker...
        </Text>
      ) : phase === 'gone' ? (
        <VStack gap="md">
          <Text variant="body" testID="account-edit-gone">
            This account is no longer on your Worker. Nothing was changed.
          </Text>
          <Button label="Close" variant="secondary" onPress={onClose} />
        </VStack>
      ) : phase === 'load-failed' ? (
        <VStack gap="md">
          <Text variant="body" tone="danger" testID="account-edit-load-failed">
            {`The account could not be read, so it can't be edited yet. ${problem ?? ''}`}
          </Text>
          <Button
            label="Try again"
            variant="secondary"
            onPress={() => void load()}
            testID="account-edit-retry"
          />
        </VStack>
      ) : phase === 'unsure' ? (
        <VStack gap="md">
          <Text variant="body" tone="danger" testID="account-edit-unsure">
            {`Your Worker did not answer, so it is not known whether your change was saved. Check again before changing anything. ${problem ?? ''}`}
          </Text>
          <Button
            label="Check again"
            variant="secondary"
            onPress={() => {
              const edit = pendingEdit.current;
              void load(edit ? { edit, why: 'lost' } : undefined);
            }}
            testID="account-edit-check"
          />
        </VStack>
      ) : phase === 'readonly' && account ? (
        <VStack gap="md">
          <Text variant="body" testID="account-edit-readonly">
            {readOnlyReason(account, data.connections)}
          </Text>
          <Button label="Close" variant="secondary" onPress={onClose} />
        </VStack>
      ) : account && draft && check ? (
        <VStack gap="md">
          {notice ? (
            <Text
              variant="body"
              tone={phase === 'saved' ? 'income' : 'pending'}
              testID="account-edit-notice"
            >
              {notice}
            </Text>
          ) : null}
          {phase === 'saved' ? (
            <Text variant="body" tone="income" testID="account-edit-saved">
              Saved.
            </Text>
          ) : null}
          <TextField
            label="Name"
            value={draft.name}
            onChangeText={(name) => set({ name })}
            maxLength={ACCOUNT_NAME_MAX + 20}
            error={tried || draft.name !== account.name ? check.problems.name : undefined}
            testID="account-edit-name"
          />
          <VStack gap="xs">
            <Text variant="label" tone="muted">
              Kind
            </Text>
            {lock ? (
              <Text variant="caption" tone="muted" testID="account-edit-kind-locked">
                {`${KIND_LABEL[account.type]}. ${lock}`}
              </Text>
            ) : (
              <>
                <HStack gap="xs" wrap>
                  {NON_CASH_KINDS.map((t) => (
                    <Chip
                      key={t}
                      label={KIND_LABEL[t]}
                      selected={draft.type === t}
                      onPress={() => set({ type: t })}
                      testID={`account-edit-kind-${t}`}
                    />
                  ))}
                </HStack>
                <Text variant="caption" tone="faint">
                  Changing the kind does not flip the sign of the balance or of any transaction.
                </Text>
              </>
            )}
            {check.problems.type ? (
              <Text variant="caption" tone="danger">
                {check.problems.type}
              </Text>
            ) : null}
          </VStack>
          <VStack gap="xs">
            <Text variant="label" tone="muted">
              {`${balanceLabel(draft.type)} now`}
            </Text>
            <SegmentedControl
              accessibilityLabel="Do you know the balance now?"
              value={draft.balance}
              onChange={(choice) => setDraft(chooseBalance(draft, choice, account))}
              options={[
                { value: 'known', label: 'I know it' },
                { value: 'unknown', label: 'Unknown' },
              ]}
            />
          </VStack>
          {draft.balance === 'known' ? (
            <>
              <TextField
                label={`${balanceLabel(draft.type)} (${liveCurrency})`}
                value={draft.amount}
                onChangeText={(amount) => set({ amount })}
                keyboardType="numbers-and-punctuation"
                placeholder="0.00"
                error={tried ? check.problems.amount : undefined}
                testID="account-edit-amount"
              />
              <Text variant="caption" tone="faint">
                {draft.type === 'cash'
                  ? 'The cash you hold now.'
                  : balanceLabel(draft.type) === 'Amount owed'
                    ? 'What you owe, as a positive number. A credit in your favour is negative.'
                    : 'What the account holds. Overdrawn is negative.'}
              </Text>
              <TextField
                label="True on (YYYY-MM-DD)"
                value={draft.asOfDate}
                onChangeText={(asOfDate) => set({ asOfDate })}
                placeholder={today}
                error={tried || check.problems.date ? check.problems.date : undefined}
                testID="account-edit-date"
              />
            </>
          ) : (
            <Text variant="caption" tone="muted" testID="account-edit-unknown-note">
              The balance shows as Unknown, never as zero, and the account stays out of net worth
              until you enter one. Transactions and imports do not change that.
            </Text>
          )}
          <VStack gap="xs">
            <HStack gap="md" align="center" justify="space-between">
              <VStack gap="xxs" flex={1}>
                <Text variant="bodyStrong">Count in net worth</Text>
                <Text variant="caption" tone="muted" testID="account-edit-networth-note">
                  {draft.balance === 'unknown'
                    ? 'An unknown balance is always left out of net worth.'
                    : check.balanceChanged
                      ? 'You are changing the balance. Choose whether this balance counts in net worth.'
                      : 'Whether this account adds to (or, for a debt, takes from) your net worth.'}
                </Text>
              </VStack>
              <Switch
                value={draft.balance === 'known' && draft.includeInNetWorth}
                onValueChange={(includeInNetWorth) => set({ includeInNetWorth })}
                disabled={draft.balance === 'unknown'}
                accessibilityLabel="Count in net worth"
                testID="account-edit-networth"
              />
            </HStack>
          </VStack>
          <Text variant="caption" tone="faint">
            {`Currency (${account.currency}) and the opening balance cannot be changed. A new balance does not add a transaction.`}
          </Text>
          {problem ? (
            <Text variant="caption" tone="danger" testID="account-edit-problem">
              {problem}
            </Text>
          ) : null}
          {tried && check.unchanged ? (
            <Text variant="caption" tone="muted" testID="account-edit-nothing">
              Nothing has changed yet.
            </Text>
          ) : null}
          <HStack gap="sm">
            <Button
              label="Save"
              loading={phase === 'saving'}
              disabled={phase === 'saved' && check.unchanged}
              onPress={() => void save()}
              testID="account-edit-save"
            />
            <Button label="Close" variant="secondary" onPress={onClose} />
          </HStack>
        </VStack>
      ) : null}
    </BottomSheet>
  );
}
