import type { AiProvider } from '@manaclaude/shared';
import { Icon } from '../../../design/components/Icon';
import { ListRow } from '../../../design/components/ListRow';
import { Switch } from '../../../design/components/Controls';
import { updateSettings, useSettings } from '../../../data/settingsStore';
import { SettingsGroup, SettingsRow } from '../SettingsRow';

const PROVIDERS: { value: AiProvider; label: string; note: string }[] = [
  {
    value: 'workers_ai',
    label: 'Workers AI',
    note: 'Free daily allowance on your Cloudflare account',
  },
  { value: 'anthropic', label: 'Anthropic', note: 'Your own API key, stored as a Worker secret' },
  { value: 'openai', label: 'OpenAI', note: 'Your own API key, stored as a Worker secret' },
  {
    value: 'openai_compatible',
    label: 'OpenAI-compatible',
    note: 'Any compatible endpoint with your key',
  },
  {
    value: 'gemini_paid',
    label: 'Gemini (paid tier)',
    note: 'Paid keys only (GEMINI_API_KEY); the free tier allows human review',
  },
];

/** AI switch, provider and MCP write tools (session B owns this section). */
export function AiSection() {
  const settings = useSettings();
  return (
    <SettingsGroup title="AI">
      <SettingsRow
        label="AI features"
        description={
          settings.aiEnabled
            ? 'One switch for every AI call: categorizing, receipts, statements, recaps'
            : 'Off: nothing is sent to any AI. Rules and your past corrections still categorize, and recaps use plain numbers.'
        }
        control={
          <Switch
            value={settings.aiEnabled}
            onValueChange={(aiEnabled) => updateSettings({ aiEnabled })}
            accessibilityLabel="AI features"
            testID="switch-ai"
          />
        }
      />
      {settings.aiEnabled
        ? PROVIDERS.map((p) => (
            <ListRow
              key={p.value}
              title={p.label}
              subtitle={p.note}
              onPress={() => updateSettings({ aiProvider: p.value })}
              trailing={
                settings.aiProvider === p.value ? <Icon name="check" tone="accent" /> : null
              }
            />
          ))
        : null}
      <SettingsRow
        label="Let AI assistants make changes"
        description="MCP write tools (categorize, add cash, tag, link transfers). Read tools are always on. Your assistant asks before each change."
        control={
          <Switch
            value={settings.mcpWriteToolsEnabled}
            onValueChange={(mcpWriteToolsEnabled) => updateSettings({ mcpWriteToolsEnabled })}
            accessibilityLabel="MCP write tools"
          />
        }
      />
    </SettingsGroup>
  );
}
