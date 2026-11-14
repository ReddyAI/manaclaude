import { useState } from 'react';
import { IconButton } from '../../../design/components/Button';
import { Icon } from '../../../design/components/Icon';
import { HStack, VStack } from '../../../design/components/Layout';
import { ListRow } from '../../../design/components/ListRow';
import { Text } from '../../../design/components/Text';
import { haptic } from '../../../design/haptics';
import { isBackendReady, useBackendConfig } from '../../../data/backend/config';
import { copyText } from '../../assistants/copy';
import { mcpServerUrl } from '../../assistants/mcpClient';
import { goTo } from '../../planning/navigate';
import { SettingsGroup, SettingsRow } from '../SettingsRow';

/**
 * AI assistants: the MCP server address to paste into Claude, Perplexity or
 * another assistant, and a way into the screen that makes a client ID and
 * secret for one that can't register itself.
 */
export function AssistantsSection() {
  const config = useBackendConfig();
  const ready = isBackendReady(config);
  const [copied, setCopied] = useState<{ scope: string; ok: boolean } | null>(null);
  const url = mcpServerUrl(config.url);
  const note = copied && copied.scope === config.scope ? copied : null;

  if (!ready) {
    return (
      <SettingsGroup title="AI assistants">
        <SettingsRow
          label="Needs the backend"
          description="Claude and Perplexity connect to your Worker. Enter its address and token in Settings, Backend."
          control={null}
        />
      </SettingsGroup>
    );
  }

  return (
    <SettingsGroup title="AI assistants">
      <SettingsRow
        label="MCP server address"
        description="Paste this into the assistant's custom connector. It signs in with your owner password."
        below
        control={
          <VStack gap="xxs">
            <HStack gap="sm">
              <VStack flex={1}>
                <Text variant="body" selectable testID="settings-mcp-url">
                  {url}
                </Text>
              </VStack>
              <IconButton
                icon="copy"
                variant="secondary"
                accessibilityLabel="Copy the MCP server address"
                onPress={() => {
                  const scope = config.scope;
                  void copyText(url).then((ok) => {
                    setCopied({ scope, ok });
                    if (ok) haptic('confirm');
                  });
                }}
                testID="settings-mcp-url-copy"
              />
            </HStack>
            {note ? (
              <Text variant="caption" tone={note.ok ? 'muted' : 'danger'}>
                {note.ok
                  ? 'Copied.'
                  : "Copying didn't work here. Press and hold the address to select it."}
              </Text>
            ) : null}
          </VStack>
        }
      />
      <ListRow
        title="Connect an assistant"
        subtitle="Make a client ID and secret for an assistant that asks for one"
        leading={<Icon name="key-round" tone="accent" />}
        onPress={() => goTo('/assistants')}
        showChevron
        testID="settings-assistants"
      />
    </SettingsGroup>
  );
}
