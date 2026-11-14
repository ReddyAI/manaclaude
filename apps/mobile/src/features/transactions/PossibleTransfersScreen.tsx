import { formatShortDate } from '@manaclaude/shared';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Button } from '../../design/components/Button';
import { Card } from '../../design/components/Card';
import { EmptyState } from '../../design/components/Decor';
import { HStack, VStack } from '../../design/components/Layout';
import { MoneyText } from '../../design/components/MoneyText';
import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import { haptic } from '../../design/haptics';
import { useLookups } from '../../data/selectors';
import { useFinanceSelector } from '../../data/store';
import { BackAction } from '../planning/BackAction';
import { confirmTransfer, rejectSuggestion } from './actions';
import { openSuggestions } from './transfers';

/**
 * Every pair the transfer matcher suggested and nobody has decided yet,
 * grouped by the transaction money left. Each pair can be confirmed (POST
 * /v1/transfer-links/:id/confirm) or turned down (POST .../reject). Until
 * then both sides count as spending or income.
 */
export function PossibleTransfersScreen() {
  const groups = useFinanceSelector((d) => openSuggestions(d));
  const lookups = useLookups();

  return (
    <Screen
      title="Possible transfers"
      actions={<BackAction fallback="/transactions" />}
      testID="screen-possible-transfers"
    >
      {groups.length === 0 ? (
        <Card>
          <EmptyState
            icon="link"
            title="Nothing to check"
            message="When money leaving one account could match more than one arrival in another, the pairs are listed here for you to pick."
          />
        </Card>
      ) : (
        <>
          <Text variant="caption" tone="muted">
            Each of these looks like money moving between your own accounts, but there was more than
            one possible match. Confirm the right pair, or turn down the ones that are not transfers
            so they are not suggested again. Until you decide, both sides count as spending or
            income.
          </Text>
          {groups.map((g) => {
            const out = lookups.transactionsById.get(g.outTransactionId)!;
            return (
              <Card key={g.outTransactionId} padding="none">
                <View style={styles.head} testID={`possible-${g.outTransactionId}`}>
                  <HStack justify="space-between" align="center">
                    <VStack flex={1}>
                      <Text variant="bodyStrong" numberOfLines={1}>
                        {out.name}
                      </Text>
                      <Text variant="caption" tone="muted" numberOfLines={1}>
                        {`${lookups.accountsById.get(out.accountId)?.name ?? 'Another account'} · ${formatShortDate(out.date)}`}
                      </Text>
                    </VStack>
                    <MoneyText amount={out.amount} currency={out.currency} colorize="signed" />
                  </HStack>
                </View>
                {g.links.map((l) => {
                  const into = lookups.transactionsById.get(l.inTransactionId)!;
                  return (
                    <View key={l.id} style={styles.row} testID={`suggestion-${l.id}`}>
                      <HStack justify="space-between" align="center">
                        <VStack flex={1}>
                          <Text variant="body" numberOfLines={1}>
                            {`To ${lookups.accountsById.get(into.accountId)?.name ?? 'another account'}`}
                          </Text>
                          <Text variant="caption" tone="muted" numberOfLines={1}>
                            {`${into.name} · ${formatShortDate(into.date)}`}
                          </Text>
                        </VStack>
                        <MoneyText
                          amount={into.amount}
                          currency={into.currency}
                          colorize="signed"
                        />
                      </HStack>
                      <HStack gap="sm">
                        <Button
                          label="Confirm"
                          icon="check"
                          size="sm"
                          onPress={() => {
                            haptic('confirm');
                            confirmTransfer(l.id);
                          }}
                          testID={`confirm-transfer-${l.id}`}
                        />
                        <Button
                          label="Not this one"
                          variant="secondary"
                          size="sm"
                          onPress={() => {
                            haptic('tap');
                            rejectSuggestion(l.id);
                          }}
                          testID={`reject-transfer-${l.id}`}
                        />
                      </HStack>
                    </View>
                  );
                })}
              </Card>
            );
          })}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create((theme) => ({
  head: {
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.md,
    borderBottomWidth: theme.size.hairline,
    borderColor: theme.colors.border,
  },
  row: {
    gap: theme.space.sm,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.md,
    borderBottomWidth: theme.size.hairline,
    borderColor: theme.colors.border,
  },
}));
