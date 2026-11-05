import { useState } from 'react';
import { Button } from '../../design/components/Button';
import { Card } from '../../design/components/Card';
import { TextField } from '../../design/components/Controls';
import { VStack } from '../../design/components/Layout';
import { Text } from '../../design/components/Text';
import { errorText } from '../../data/backend/client';
import { linkApi } from './linkApi';
import type { FlowProps } from './types';

const HELP: Record<'coinbase' | 'wazirx', { steps: string; key: string; secret: string }> = {
  coinbase: {
    steps:
      'Make a read-only key: on coinbase.com open Settings, then API (Coinbase Developer Platform), create an API key and tick only View. Do not allow trading or transfers. Copy the key name and the private key.',
    key: 'API key name',
    secret: 'Private key',
  },
  wazirx: {
    steps:
      'Make a read-only key: in WazirX open Settings, then API Key Management, create a key and leave trading and withdrawals off. Copy the API key and the secret key.',
    key: 'API key',
    secret: 'Secret key',
  },
};

/** Coinbase and WazirX: a read-only key pair, checked with the exchange before it is saved. */
export function KeysFlow({ connector, connectionId, onLinked }: FlowProps) {
  const which = connector === 'wazirx' ? 'wazirx' : 'coinbase';
  const help = HELP[which];
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const done = await linkApi.keys({
        connectorId: which,
        apiKey: apiKey.trim(),
        apiSecret: apiSecret.trim(),
        connectionId,
      });
      setApiKey('');
      setApiSecret('');
      onLinked(done.connectionIds, done.repaired);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <VStack gap="md">
        <Text variant="body" testID="keys-help">
          {help.steps}
        </Text>
        <TextField
          label={help.key}
          value={apiKey}
          onChangeText={setApiKey}
          autoCapitalize="none"
          autoCorrect={false}
          testID="keys-key"
        />
        <TextField
          label={help.secret}
          value={apiSecret}
          onChangeText={setApiSecret}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry={which === 'wazirx'}
          multiline={which === 'coinbase'}
          testID="keys-secret"
        />
        {error ? (
          <Text variant="caption" tone="danger" testID="link-error">
            {error}
          </Text>
        ) : null}
        <Button
          label="Check and save"
          loading={busy}
          disabled={apiKey.trim().length < 8 || apiSecret.trim().length < 8}
          onPress={save}
          testID="keys-save"
        />
      </VStack>
    </Card>
  );
}
