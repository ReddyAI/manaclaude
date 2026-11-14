import { useState } from 'react';
import { formatShortDate, type Transaction, type TransferLink } from '@manaclaude/shared';
import { Banner } from '../../design/components/Decor';
import { Button } from '../../design/components/Button';
import { HStack, VStack } from '../../design/components/Layout';
import { MoneyText } from '../../design/components/MoneyText';
import { Text } from '../../design/components/Text';
import { haptic } from '../../design/haptics';
import type { Lookups } from '../../data/selectors';
import { useFinanceSelector } from '../../data/store';
import { confirmTransfer, rejectSuggestion, unlinkTransfer } from './actions';
import { LinkTransferSheet } from './LinkTransferSheet';
import { suggestionsFor } from './transfers';

/**
 * Transfer controls on the transaction detail:
 * - a linked transfer shows both sides and can be unlinked;
 * - each pair the matcher suggested (it found several candidates) can be
 *   confirmed or turned down on its own;
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
  const allLinks = useFinanceSelector((d) => d.transferLinks);

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

  // The Worker's suggestions are found by the pair's ids; `suggestion` covers one the
  // transaction points at (made on this device).
  const found = suggestionsFor(allLinks, txn.id);
  const suggestions =
    suggestion && !found.some((l) => l.id === suggestion.id) ? [suggestion, ...found] : found;
  if (suggestions.length > 0) {
    return (
      <VStack gap="sm" testID="transfer-suggestion">
        <Banner icon="link">
          <Text variant="bodyStrong">
            {suggestions.length === 1
              ? 'Looks like a transfer between your accounts'
              : `Looks like a transfer: ${suggestions.length} possible matches`}
          </Text>
          <Text variant="caption" tone="muted">
            It counts as spending or income until you confirm one. Turning a pair down keeps it from
            being suggested again.
          </Text>
        </Banner>
        {suggestions.map((s) => {
          const otherId = s.outTransactionId === txn.id ? s.inTransactionId : s.outTransactionId;
          const other = lookups.transactionsById.get(otherId);
          return (
            <VStack key={s.id} gap="xs" testID={`suggestion-${s.id}`}>
              <HStack justify="space-between" align="center">
                <VStack flex={1}>
                  <Text variant="body" numberOfLines={1}>
                    {other
                      ? (lookups.accountsById.get(other.accountId)?.name ?? 'Another account')
                      : 'A transaction not on this device'}
                  </Text>
                  {other ? (
                    <Text variant="caption" tone="muted" numberOfLines={1}>
                      {`${other.name} · ${formatShortDate(other.date)}`}
                    </Text>
                  ) : null}
                </VStack>
                {other ? (
                  <MoneyText amount={other.amount} currency={other.currency} colorize="signed" />
                ) : null}
              </HStack>
              <HStack gap="sm">
                <Button
                  label="Confirm"
                  icon="check"
                  size="sm"
                  onPress={() => {
                    haptic('confirm');
                    confirmTransfer(s.id);
                  }}
                  testID={`confirm-transfer-${s.id}`}
                />
                <Button
                  label={suggestions.length === 1 ? 'Not a transfer' : 'Not this one'}
                  variant="secondary"
                  size="sm"
                  onPress={() => {
                    haptic('tap');
                    rejectSuggestion(s.id);
                  }}
                  testID={`reject-transfer-${s.id}`}
                />
              </HStack>
            </VStack>
          );
        })}
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
