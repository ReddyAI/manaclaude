import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import type { Transaction } from '@manaclaude/shared';
import { EmptyState } from '../../design/components/Decor';
import { Screen } from '../../design/components/Screen';
import { useLookups } from '../../data/selectors';
import { CurrencyChip } from '../currency/CurrencyChip';
import { TransactionDetailSheet } from './TransactionDetailSheet';

/** /transactions/<id>: opens one transaction's detail, for links from other screens. */
export function TransactionRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const lookups = useLookups();
  const txn = id ? (lookups.transactionsById.get(id) ?? null) : null;
  // Kept after the transaction leaves the data (a cash entry deleted from its
  // detail), so the sheet can still say what happened.
  const [last, setLast] = useState<Transaction | null>(txn);
  if (txn && txn !== last) setLast(txn);
  const shown = txn ?? (last?.id === id ? last : null);
  const leave = () => (router.canGoBack() ? router.back() : router.replace('/transactions'));
  return (
    <Screen title="Transaction" actions={<CurrencyChip />} testID="screen-transaction">
      {txn ? null : (
        <EmptyState
          icon="search"
          title="Transaction not found"
          message="It may have been removed or merged."
          actionLabel="Back to transactions"
          onAction={leave}
        />
      )}
      <TransactionDetailSheet txn={shown} lookups={lookups} onClose={leave} />
    </Screen>
  );
}
