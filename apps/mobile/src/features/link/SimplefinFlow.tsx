import { useState } from 'react';
import { Button } from '../../design/components/Button';
import { Card } from '../../design/components/Card';
import { TextField } from '../../design/components/Controls';
import { VStack } from '../../design/components/Layout';
import { Text } from '../../design/components/Text';
import { errorText } from '../../data/backend/client';
import { linkApi } from './linkApi';
import type { FlowProps } from './types';

/** SimpleFIN: paste a setup token from SimpleFIN Bridge; the backend claims it once for the access URL. */
export function SimplefinFlow({ connectionId, onLinked }: FlowProps) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const done = await linkApi.simplefin(token.trim(), connectionId);
      setToken('');
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
        <Text variant="body">
          On SimpleFIN Bridge (beta-bridge.simplefin.org), connect your banks, then choose New
          connection, Create setup token, and copy it. A token works once.
        </Text>
        <TextField
          label="Setup token"
          value={token}
          onChangeText={setToken}
          placeholder="Paste the setup token"
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          secureTextEntry={false}
          testID="simplefin-token"
        />
        {error ? (
          <Text variant="caption" tone="danger" testID="link-error">
            {error}
          </Text>
        ) : null}
        <Button
          label="Connect"
          loading={busy}
          disabled={token.trim().length < 20}
          onPress={connect}
          testID="simplefin-connect"
        />
      </VStack>
    </Card>
  );
}
