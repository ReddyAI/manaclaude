import { useState } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Button } from '../../../design/components/Button';
import { TextField } from '../../../design/components/Controls';
import { HStack } from '../../../design/components/Layout';
import { Text } from '../../../design/components/Text';
import { haptic } from '../../../design/haptics';
import { api, errorText } from '../../../data/backend/client';
import {
  forgetBackendToken,
  isValidUrl,
  normalizeUrl,
  saveBackendConfig,
  useBackendConfig,
} from '../../../data/backend/config';
import { refreshDataset, useBackendStatus } from '../../../data/backend/sync';
import { SettingsGroup } from '../SettingsRow';

function ago(iso: string | null): string {
  if (!iso) return '';
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

/**
 * Backend (session E2): the Worker URL and the APP_API_TOKEN. The token is
 * checked against the Worker before it is saved, then kept in the phone's
 * secure storage (browser storage on the web) and never shown again.
 */
export function BackendSection() {
  const config = useBackendConfig();
  const status = useBackendStatus();
  const [url, setUrl] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<{ tone: 'danger' | 'muted'; text: string } | null>(null);
  const shownUrl = url ?? config.url;
  const hasToken = config.token !== '';

  const save = async () => {
    const nextUrl = normalizeUrl(shownUrl);
    const nextToken = token.trim() || config.token;
    if (!isValidUrl(nextUrl)) {
      setMessage({ tone: 'danger', text: 'Enter the Worker address, starting with https://.' });
      return;
    }
    if (!nextToken) {
      setMessage({ tone: 'danger', text: 'Paste your APP_API_TOKEN.' });
      return;
    }
    setChecking(true);
    setMessage(null);
    try {
      // A cheap call that needs the token, so a wrong one is caught before it is saved.
      await api('GET', '/v1/link/options', undefined, {
        url: nextUrl,
        token: nextToken,
        timeoutMs: 15_000,
      });
      await saveBackendConfig({ url: nextUrl, token: nextToken });
      setToken('');
      setUrl(null);
      setMessage({ tone: 'muted', text: 'Connected. Loading your data.' });
      haptic('confirm');
    } catch (e) {
      setMessage({ tone: 'danger', text: errorText(e) });
      haptic('reject');
    } finally {
      setChecking(false);
    }
  };

  const statusText =
    status.mode === 'sample'
      ? 'Showing made-up sample data. Enter your Worker address and API token to use your own.'
      : status.loading
        ? 'Loading your data...'
        : `Using your data, loaded ${ago(status.lastLoadedAt)}${status.fromCache ? ' (saved copy)' : ''}.`;

  return (
    <SettingsGroup title="Backend">
      <View style={styles.body} testID="settings-backend">
        <Text variant="caption" tone={status.error ? 'danger' : 'muted'}>
          {status.error ?? statusText}
        </Text>
        <TextField
          label="Worker URL"
          value={shownUrl}
          onChangeText={setUrl}
          placeholder="https://manaclaude-api.<you>.workers.dev"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          testID="backend-url"
        />
        <TextField
          label="API token (APP_API_TOKEN)"
          value={token}
          onChangeText={setToken}
          placeholder={
            hasToken
              ? 'Saved. Paste a new one to replace it'
              : 'Paste it from your password manager'
          }
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          testID="backend-token"
        />
        {message ? (
          <Text variant="caption" tone={message.tone}>
            {message.text}
          </Text>
        ) : null}
        <HStack gap="sm" wrap>
          <Button
            label={hasToken ? 'Save' : 'Save and connect'}
            size="sm"
            onPress={save}
            loading={checking}
            testID="backend-save"
          />
          {hasToken ? (
            <Button
              label="Reload data"
              size="sm"
              variant="secondary"
              icon="refresh-cw"
              onPress={() => void refreshDataset()}
              loading={status.loading}
            />
          ) : null}
          {hasToken ? (
            <Button
              label="Forget token"
              size="sm"
              variant="ghost"
              onPress={() => {
                void forgetBackendToken();
                setMessage({ tone: 'muted', text: 'Token removed. Showing sample data.' });
              }}
            />
          ) : null}
        </HStack>
      </View>
    </SettingsGroup>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.space.md,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.md,
  },
}));
