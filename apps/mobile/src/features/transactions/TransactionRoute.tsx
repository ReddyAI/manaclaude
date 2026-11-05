import { router, useLocalSearchParams } from 'expo-router';
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
      <TransactionDetailSheet txn={txn} lookups={lookups} onClose={leave} />
    </Screen>
  );
}
