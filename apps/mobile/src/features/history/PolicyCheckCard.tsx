import { useEffect, useMemo, useState } from 'react';
import type { Account, ImportRecord, PolicyPreview, Transaction } from '@manaclaude/shared';
import { Button } from '../../design/components/Button';
import { Card } from '../../design/components/Card';
import { HStack, VStack } from '../../design/components/Layout';
import { Text } from '../../design/components/Text';
import { listImports } from '../import/importApi';
import { goTo } from '../planning/navigate';
import { withYear } from './historyModel';

interface ConflictGroup {
  key: string;
  text: string;
}

/** The Worker's conflicts, grouped by import (Monefy in bank dates) or by account (bank in Monefy dates). */
export function conflictGroups(
  preview: PolicyPreview,
  accounts: readonly Account[],
  transactions: readonly Transaction[],
  fileNames: ReadonlyMap<string, string>,
): ConflictGroup[] {
  const name = (id: string) => accounts.find((a) => a.id === id)?.name ?? 'an account';
  const groups = new Map<
    string,
    { reason: string; account: string; importId: string | null; ids: string[] }
  >();
  for (const c of preview.conflicts) {
    const key =
      c.reason === 'monefy_in_bank_period'
        ? `m:${c.importId ?? 'none'}:${c.accountId}`
        : `b:${c.accountId}`;
    const g = groups.get(key) ?? {
      reason: c.reason,
      account: c.accountId,
      importId: c.importId,
      ids: [],
    };
    g.ids.push(c.transactionId);
    groups.set(key, g);
  }
  const dates = (ids: string[]) => {
    const ds = ids
      .map((id) => transactions.find((t) => t.id === id)?.date)
      .filter((d): d is string => !!d)
      .sort();
    if (ds.length === 0) return '';
    return ds[0] === ds[ds.length - 1]
      ? ` (${withYear(ds[0]!)})`
      : ` (${withYear(ds[0]!)} to ${withYear(ds[ds.length - 1]!)})`;
  };
  return [...groups.entries()].map(([key, g]) => {
    const n = g.ids.length;
    if (g.reason === 'monefy_in_bank_period') {
      const file = g.importId ? fileNames.get(g.importId) : undefined;
      return {
        key,
        text: `${n} Monefy ${n === 1 ? 'entry' : 'entries'} in "${name(g.account)}" ${n === 1 ? 'falls' : 'fall'} on dates the bank would own${dates(g.ids)}. They came from ${file ? `the import "${file}"` : 'an import'}. Undo that import (Import, History), save these settings, then import the same file again: it is read afresh under them. Undo removes everything that import added, in every account.`,
      };
    }
    return {
      key,
      text: `${n} bank ${n === 1 ? 'transaction' : 'transactions'} in "${name(g.account)}" ${n === 1 ? 'falls' : 'fall'} on dates Monefy would own${dates(g.ids)}. Nothing is deleted for you: choose a cutoff or months that leave ${n === 1 ? 'it' : 'them'} with the bank.`,
    };
  });
}

/**
 * The Worker's answer to "check these settings": ready to save, or what
 * stops it and what to do. Nothing is saved, hidden or deleted by a check.
 */
export function PolicyCheckCard({
  preview,
  accounts,
  transactions,
  busy,
  onSave,
}: {
  preview: PolicyPreview;
  accounts: readonly Account[];
  transactions: readonly Transaction[];
  busy: boolean;
  onSave: () => void;
}) {
  const [imports, setImports] = useState<ImportRecord[]>([]);
  const needsNames = preview.conflicts.some((c) => c.importId);
  useEffect(() => {
    if (!needsNames) return;
    let live = true;
    listImports()
      .then((list) => live && setImports(list))
      // Without the list the conflicts still show, only without file names.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [needsNames]);
  const fileNames = useMemo(() => new Map(imports.map((i) => [i.id, i.fileName])), [imports]);
  const groups = conflictGroups(preview, accounts, transactions, fileNames);
  const boundary = preview.boundaryCandidates.length;

  return (
    <Card>
      <VStack gap="sm" testID="history-check">
        <Text variant="headline" testID="history-check-headline">
          {preview.allowed ? 'Ready to save' : 'These settings cannot be saved yet'}
        </Text>
        {groups.map((g) => (
          <Text key={g.key} variant="body" testID="history-conflict">
            {g.text}
          </Text>
        ))}
        {boundary > 0 ? (
          <Text variant="body" testID="history-boundary">
            {`${boundary} saved bank ${boundary === 1 ? 'transaction looks' : 'transactions look'} like a saved Monefy entry (same account, currency and amount within three days), and no one has said whether they are the same purchase. Undo the Monefy import that holds them, or choose periods that keep each pair on one side.`}
          </Text>
        ) : null}
        {preview.pendingBankReviews > 0 ? (
          <VStack gap="xs">
            <Text variant="body" testID="history-pending-reviews">
              {`${preview.pendingBankReviews} bank ${preview.pendingBankReviews === 1 ? 'transaction waits' : 'transactions wait'} for your review. Settle them first.`}
            </Text>
            <HStack>
              <Button
                label="Review bank transactions"
                size="sm"
                variant="secondary"
                onPress={() => goTo('/history/reviews')}
                testID="history-open-reviews"
              />
            </HStack>
          </VStack>
        ) : null}
        {preview.warnings.map((w) => (
          <Text key={w} variant="caption" tone="muted">
            {w}
          </Text>
        ))}
        {preview.allowed ? (
          <Button
            label="Save these settings"
            loading={busy}
            onPress={onSave}
            testID="history-save"
          />
        ) : null}
      </VStack>
    </Card>
  );
}
