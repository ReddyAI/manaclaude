import { useRef, useState } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { McpClientResponse } from '@manaclaude/shared';
import { Button, IconButton } from '../../design/components/Button';
import { Card } from '../../design/components/Card';
import { TextField } from '../../design/components/Controls';
import { Banner, EmptyState } from '../../design/components/Decor';
import { HStack, VStack } from '../../design/components/Layout';
import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import { haptic } from '../../design/haptics';
import { isBackendReady, useBackendConfig } from '../../data/backend/config';
import { BackAction } from '../planning/BackAction';
import { copyText } from './copy';
import {
  checkDraft,
  createFailure,
  createMcpClient,
  EMPTY_DRAFT,
  mcpServerUrl,
  NAME_MAX,
  REDIRECTS_MAX,
  type CreateFailure,
  type McpClientDraft,
} from './mcpClient';

interface Made extends McpClientResponse {
  name: string;
}

/** One value with a copy button and a line saying whether it was copied. */
function CopyRow({
  label,
  value,
  sensitive = false,
  testID,
}: {
  label: string;
  value: string;
  sensitive?: boolean;
  testID: string;
}) {
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <VStack gap="xxs">
      <Text variant="label" tone="muted">
        {label}
      </Text>
      <HStack gap="sm">
        <View style={styles.value}>
          <Text variant="body" selectable testID={testID}>
            {value}
          </Text>
        </View>
        <IconButton
          icon="copy"
          variant="secondary"
          accessibilityLabel={`Copy ${label.toLowerCase()}`}
          onPress={() => {
            void copyText(value, { sensitive }).then((ok) => {
              setCopied(ok);
              if (ok) haptic('confirm');
            });
          }}
          testID={`${testID}-copy`}
        />
      </HStack>
      {copied === true ? (
        <Text variant="caption" tone="muted">
          Copied.
        </Text>
      ) : copied === false ? (
        <Text variant="caption" tone="danger">
          {"Copying didn't work here. Press and hold the text to select it."}
        </Text>
      ) : null}
    </VStack>
  );
}

/**
 * Connect Claude, Perplexity or another assistant to the Worker's MCP server
 * with a client made by hand (POST /v1/mcp/clients).
 *
 * The client secret lives only in this screen's state: it is never written
 * to the device or logged, and it is gone when the screen closes, when you
 * press Done, or when the backend changes.
 */
export function ConnectAssistantScreen() {
  const config = useBackendConfig();
  const ready = isBackendReady(config);
  const [draft, setDraft] = useState<McpClientDraft>(EMPTY_DRAFT);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<Made | null>(null);
  const [failure, setFailure] = useState<CreateFailure | null>(null);
  // Set at the moment of the tap, so a fast second tap can't make two clients.
  const sending = useRef(false);

  // Another backend: the secret and everything typed for the old one go.
  const [shownScope, setShownScope] = useState(config.scope);
  if (shownScope !== config.scope) {
    setShownScope(config.scope);
    setDraft(EMPTY_DRAFT);
    setTried(false);
    setMade(null);
    setFailure(null);
  }

  const back = <BackAction fallback="/settings" />;
  if (!ready) {
    return (
      <Screen title="Connect an assistant" actions={back} testID="screen-assistant">
        <Card>
          <EmptyState
            icon="cloud-off"
            title="Set up the backend first"
            message="Assistants connect to your Worker. Enter its address and your API token in Settings, Backend."
          />
        </Card>
      </Screen>
    );
  }

  const serverUrl = mcpServerUrl(config.url);
  const check = checkDraft(draft);

  const create = async () => {
    setTried(true);
    if (!check.body || sending.current) return;
    sending.current = true;
    setBusy(true);
    setFailure(null);
    const name = check.body.name;
    try {
      const res = await createMcpClient(check.body);
      setMade({ name, clientId: res.clientId, clientSecret: res.clientSecret });
      setDraft(EMPTY_DRAFT);
      setTried(false);
      haptic('confirm');
    } catch (e) {
      setFailure(createFailure(e));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  const setRedirect = (i: number, text: string) =>
    setDraft((d) => ({ ...d, redirects: d.redirects.map((r, j) => (j === i ? text : r)) }));

  return (
    <Screen title="Connect an assistant" actions={back} testID="screen-assistant">
      <Card>
        <VStack gap="sm">
          <Text variant="bodyStrong">The MCP server address</Text>
          <Text variant="caption" tone="muted">
            {
              "Paste this into the assistant's custom connector (in Claude: Settings, Connectors, Add custom connector). Most assistants then sign in by themselves with your owner password, and you need nothing else on this screen."
            }
          </Text>
          <CopyRow label="Server address" value={serverUrl} testID="mcp-server-url" />
        </VStack>
      </Card>

      {made ? (
        <Card>
          <VStack gap="md">
            <Text variant="bodyStrong" testID="mcp-made">
              {`Client made for "${made.name}"`}
            </Text>
            <CopyRow label="Client ID" value={made.clientId} testID="mcp-client-id" />
            {made.clientSecret !== null ? (
              <>
                <CopyRow
                  label="Client secret"
                  value={made.clientSecret}
                  sensitive
                  testID="mcp-client-secret"
                />
                <Banner tone="pending" icon="triangle-alert">
                  <Text variant="bodyStrong" testID="mcp-secret-warning">
                    {"This secret is shown only now and can't be shown again."}
                  </Text>
                  <Text variant="caption" tone="muted">
                    {
                      "Your Worker keeps only a scrambled copy of it, and this app doesn't save it. Paste it into the assistant before you leave this screen. If you lose it, make a new client."
                    }
                  </Text>
                </Banner>
              </>
            ) : (
              <Text variant="caption" tone="muted" testID="mcp-no-secret">
                Your Worker made this client without a secret. Paste only the client ID.
              </Text>
            )}
            <Button
              label="Done, I've pasted them"
              variant="secondary"
              onPress={() => setMade(null)}
              testID="mcp-done"
            />
          </VStack>
        </Card>
      ) : (
        <Card>
          <VStack gap="md">
            <VStack gap="xs">
              <Text variant="bodyStrong">Make a client ID and secret</Text>
              <Text variant="caption" tone="muted">
                {
                  "Only for an assistant that asks for a client ID and secret (Perplexity sometimes does). Copy the redirect (callback) address from the assistant's form."
                }
              </Text>
            </VStack>
            <TextField
              label="Assistant name"
              value={draft.name}
              onChangeText={(name) => setDraft((d) => ({ ...d, name }))}
              placeholder="Perplexity"
              maxLength={NAME_MAX + 20}
              autoComplete="off"
              autoCorrect={false}
              editable={!busy}
              error={tried ? check.name : undefined}
              testID="mcp-name"
            />
            {draft.redirects.map((r, i) => (
              <HStack key={i} gap="sm" align="flex-start">
                <View style={styles.value}>
                  <TextField
                    label={
                      draft.redirects.length > 1 ? `Redirect address ${i + 1}` : 'Redirect address'
                    }
                    value={r}
                    onChangeText={(t) => setRedirect(i, t)}
                    placeholder="https://"
                    autoCapitalize="none"
                    autoComplete="off"
                    autoCorrect={false}
                    keyboardType="url"
                    editable={!busy}
                    error={tried ? check.redirects[i] : undefined}
                    testID={`mcp-redirect-${i}`}
                  />
                </View>
                {draft.redirects.length > 1 ? (
                  <View style={styles.remove}>
                    <IconButton
                      icon="x"
                      accessibilityLabel={`Remove redirect address ${i + 1}`}
                      disabled={busy}
                      onPress={() =>
                        setDraft((d) => ({
                          ...d,
                          redirects: d.redirects.filter((_, j) => j !== i),
                        }))
                      }
                      testID={`mcp-redirect-remove-${i}`}
                    />
                  </View>
                ) : null}
              </HStack>
            ))}
            {draft.redirects.length < REDIRECTS_MAX ? (
              <Button
                label="Add another address"
                icon="plus"
                size="sm"
                variant="ghost"
                disabled={busy}
                onPress={() => setDraft((d) => ({ ...d, redirects: [...d.redirects, ''] }))}
                testID="mcp-redirect-add"
              />
            ) : (
              <Text variant="caption" tone="muted">
                {`At most ${REDIRECTS_MAX} addresses.`}
              </Text>
            )}
            {failure ? (
              <Text
                variant="caption"
                tone={failure.kind === 'unknown' ? 'default' : 'danger'}
                testID="mcp-failure"
              >
                {failure.text}
              </Text>
            ) : null}
            <Button
              label="Make the client"
              icon="key-round"
              loading={busy}
              onPress={() => void create()}
              testID="mcp-create"
            />
          </VStack>
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create((theme) => ({
  value: { flex: 1, minWidth: 0 },
  remove: { paddingTop: theme.space.lg },
}));
