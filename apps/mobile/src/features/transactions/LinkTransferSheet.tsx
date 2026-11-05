import { useMemo } from 'react';
import { formatShortDate, type Transaction } from '@manaclaude/shared';
import { BottomSheet } from '../../design/components/BottomSheet';
import { Badge } from '../../design/components/Controls';
import { EmptyState, IconBadge } from '../../design/components/Decor';
import { ListRow } from '../../design/components/ListRow';
import { MoneyText } from '../../design/components/MoneyText';
import { Text } from '../../design/components/Text';
import { haptic } from '../../design/haptics';
import { useFinance } from '../../data/store';
import { linkTransfer } from './actions';
import { transferCandidates } from './transfers';

/**
 * Link a transaction to its other side by hand. Lists likely counterparts
 * (opposite sign, another account, close in date and amount); one tap links.
 */
export function LinkTransferSheet({
  txn,
  visible,
  onClose,
}: {
  txn: Transaction;
  visible: boolean;
  onClose: () => void;
}) {
  const data = useFinance();
  const accounts = useMemo(() => new Map(data.accounts.map((a) => [a.id, a])), [data.accounts]);
  const candidates = useMemo(
    () => (visible ? transferCandidates(data, txn) : []),
    [data, txn, visible],
  );
  const direction = txn.amount < 0 ? 'came in' : 'left';

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title="Link as a transfer"
      scrollable
      testID="link-sheet"
    >
      <Text variant="caption" tone="muted">
        {`Pick the matching transaction where the money ${direction} another of your accounts. Linked pairs show once and stay out of spending and income.`}
      </Text>
      {candidates.length === 0 ? (
        <EmptyState
          icon="link"
          title="No likely match"
          message="No transaction in another account has the opposite sign within a week of this one."
        />
      ) : (
        candidates.map(({ txn: other, score }) => (
          <ListRow
            key={other.id}
            title={accounts.get(other.accountId)?.name ?? 'Account'}
            subtitle={`${other.name} · ${formatShortDate(other.date)}`}
            leading={<IconBadge icon="link" color="c9" size="sm" />}
            trailing={
              <>
                <MoneyText amount={other.amount} currency={other.currency} colorize="flow" />
                {score >= 0.85 ? <Badge label="Likely" tone="income" /> : null}
              </>
            }
            onPress={() => {
              haptic('confirm');
              linkTransfer(txn.id, other.id);
              onClose();
            }}
            testID={`link-candidate-${other.id}`}
          />
        ))
      )}
    </BottomSheet>
  );
}
