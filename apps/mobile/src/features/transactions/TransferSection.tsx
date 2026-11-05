import { useState } from 'react';
import type { Transaction, TransferLink } from '@manaclaude/shared';
import { Banner } from '../../design/components/Decor';
import { Button } from '../../design/components/Button';
import { HStack, VStack } from '../../design/components/Layout';
import { MoneyText } from '../../design/components/MoneyText';
import { Text } from '../../design/components/Text';
import { haptic } from '../../design/haptics';
import type { Lookups } from '../../data/selectors';
import { confirmTransfer, unlinkTransfer } from './actions';
import { transferTitle } from './display';
import { LinkTransferSheet } from './LinkTransferSheet';

/**
 * Transfer controls on the transaction detail:
 * - a linked transfer shows both sides and can be unlinked;
 * - a suggested link (several candidates) can be confirmed or rejected;
 * - anything else can be linked by hand.
 */
export function TransferSection({
  txn,
  link,
  suggestion,
  lookups,
}: {
  txn: Transaction;
  link: TransferLink | null;
  suggestion: TransferLink | null;
  lookups: Lookups;
}) {
  const [linking, setLinking] = useState(false);

  if (link) {
    return (
      <VStack gap="sm" testID="transfer-section">
        <Text variant="label" tone="muted" uppercase>
          Both sides
        </Text>
        {[link.outTransactionId, link.inTransactionId].map((id) => {
          const side = lookups.transactionsById.get(id);
          if (!side) return null;
          return (
            <HStack key={id} justify="space-between" testID={`transfer-side-${id}`}>
              <Text variant="body">{lookups.accountsById.get(side.accountId)?.name}</Text>
              <MoneyText amount={side.amount} currency={side.currency} colorize="signed" />
            </HStack>
          );
        })}
        {link.outCurrency !== link.inCurrency ? (
          <Text variant="caption" tone="muted" numeric>
            {`Rate you got: 1 ${link.outCurrency} = ${link.impliedRate.toFixed(4)} ${link.inCurrency}`}
          </Text>
        ) : null}
        <Text variant="caption" tone="faint">
          Shown once and left out of spending and income.
        </Text>
        <HStack>
          <Button
            label="Unlink"
            icon="x"
            variant="danger"
            size="sm"
            onPress={() => {
              haptic('tap');
              unlinkTransfer(link.id);
            }}
            testID="unlink-transfer"
          />
        </HStack>
      </VStack>
    );
  }

  if (suggestion) {
    return (
      <VStack gap="sm" testID="transfer-suggestion">
        <Banner icon="link">
          <Text variant="bodyStrong">{transferTitle(suggestion, lookups)}</Text>
          <Text variant="caption" tone="muted">
            Looks like a transfer between your accounts, but there were several possible matches. It
            counts as spending or income until you confirm.
          </Text>
        </Banner>
        <HStack gap="sm">
          <Button
            label="Confirm transfer"
            icon="check"
            size="sm"
            onPress={() => {
              haptic('confirm');
              confirmTransfer(suggestion.id);
            }}
            testID="confirm-transfer"
          />
          <Button
            label="Not a transfer"
            variant="secondary"
            size="sm"
            onPress={() => {
              haptic('tap');
              unlinkTransfer(suggestion.id);
            }}
            testID="reject-transfer"
          />
        </HStack>
      </VStack>
    );
  }

  if (txn.isSplitParent || txn.splitParentId || txn.pending) return null;
  return (
    <>
      <HStack>
        <Button
          label="Link as transfer"
          icon="link"
          variant="secondary"
          size="sm"
          onPress={() => setLinking(true)}
          testID="link-transfer"
        />
      </HStack>
      <LinkTransferSheet txn={txn} visible={linking} onClose={() => setLinking(false)} />
    </>
  );
}
