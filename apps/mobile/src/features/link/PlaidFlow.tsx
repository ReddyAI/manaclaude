import type { LinkOptionsResponse } from '@manaclaude/shared';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { Button } from '../../design/components/Button';
import { Card } from '../../design/components/Card';
import { HStack, VStack } from '../../design/components/Layout';
import { Text } from '../../design/components/Text';
import { errorText } from '../../data/backend/client';
import { goBack } from '../planning/navigate';
import { linkApi } from './linkApi';
import { openPlaidLink } from './plaidLink';
import type { FlowProps } from './types';

/** The exact question asked before a new Plaid login, with the lifetime logins left. */
export function plaidConfirmText(left: number, total = 10): string {
  return `This uses 1 of your ${total} lifetime Plaid connections (${left} left). Continue?`;
}

/**
 * Plaid: only for a bank Sophtron and SimpleFIN can't reach. A new login asks
 * first, because Plaid's free plan allows 10 logins for life. A repair uses
 * Plaid Link's update mode on the same login and spends nothing.
 */
export function PlaidFlow({ connectionId, onLinked }: FlowProps) {
  const [options, setOptions] = useState<LinkOptionsResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    linkApi.options().then(setOptions, (e: unknown) => setError(errorText(e)));
  }, []);
  const plaid = options?.connectors.find((c) => c.id === 'plaid');
  const left = plaid?.slots.left ?? 0;
  const total = plaid?.slots.total ?? 10;

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const platform = Platform.OS === 'web' ? 'web' : Platform.OS === 'ios' ? 'ios' : 'android';
      const { linkToken } = await linkApi.plaidToken(platform, connectionId);
      const result = await openPlaidLink(linkToken);
      if (!result) return;
      const done = await linkApi.plaidExchange(
        connectionId
          ? { connectionId }
          : {
              publicToken: result.publicToken,
              institutionName: result.institutionName ?? undefined,
            },
      );
      onLinked(done.connectionIds, done.repaired);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (!options && !error) return null;
  return (
    <Card>
      <VStack gap="md">
        {connectionId ? (
          <Text variant="body">
            Repairing opens Plaid for the same login. It does not use a lifetime connection.
          </Text>
        ) : (
          <Text variant="headline" testID="plaid-confirm">
            {plaidConfirmText(left, total)}
          </Text>
        )}
        {error ? (
          <Text variant="caption" tone="danger" testID="link-error">
            {error}
          </Text>
        ) : null}
        <HStack gap="sm">
          <Button
            label={connectionId ? 'Open Plaid' : 'Continue'}
            loading={busy}
            disabled={!connectionId && left <= 0}
            onPress={go}
            testID="plaid-continue"
          />
          <Button label="Cancel" variant="ghost" onPress={() => goBack('/link')} />
        </HStack>
      </VStack>
    </Card>
  );
}
