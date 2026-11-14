import { Pressable, View } from 'react-native';
import { LOOKS, type Look } from '@manaclaude/shared';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { SegmentedControl, Switch } from '../../../design/components/Controls';
import { Text } from '../../../design/components/Text';
import { haptic } from '../../../design/haptics';
import { LOOK_LABELS, LOOK_TOKENS } from '../../../design/tokens';
import { updateSettings, useSettings } from '../../../data/settingsStore';
import { SettingsGroup, SettingsRow } from '../SettingsRow';

/** Look switch, light/dark and haptics (foundation). */
export function AppearanceSection() {
  const settings = useSettings();
  const { theme } = useUnistyles();
  return (
    <SettingsGroup title="Appearance">
      <View style={styles.looks}>
        {LOOKS.map((look: Look) => {
          const selected = settings.look === look;
          const c = LOOK_TOKENS[look].colors[theme.scheme];
          return (
            <Pressable
              key={look}
              onPress={() => {
                haptic('selection');
                updateSettings({ look });
              }}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={`${LOOK_LABELS[look].name} look`}
              style={styles.lookCard(selected)}
              testID={`look-${look}`}
            >
              <View style={styles.preview(c.canvas)}>
                <View style={styles.previewCard(c.surface, LOOK_TOKENS[look].radius.md)}>
                  <View style={styles.previewBar(c.netWorth, 3)} />
                  <View style={styles.previewBar(c.income, 2)} />
                  <View style={styles.previewBar(c.spending, 1)} />
                </View>
              </View>
              <Text variant="bodyStrong">{LOOK_LABELS[look].name}</Text>
              <Text variant="caption" tone="muted" testID={`look-${look}-description`}>
                {LOOK_LABELS[look].description}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <SettingsRow
        label="Light or dark"
        below
        control={
          <SegmentedControl
            accessibilityLabel="Light or dark"
            value={settings.colorScheme}
            onChange={(colorScheme) => updateSettings({ colorScheme })}
            options={[
              { value: 'system', label: 'System', icon: 'monitor' },
              { value: 'light', label: 'Light', icon: 'sun' },
              { value: 'dark', label: 'Dark', icon: 'moon' },
            ]}
          />
        }
      />
      <SettingsRow
        label="Haptics"
        description="Vibration when you review, scrub a chart or flip a switch"
        control={
          <Switch
            value={settings.hapticsEnabled}
            onValueChange={(hapticsEnabled) => updateSettings({ hapticsEnabled })}
            accessibilityLabel="Haptics"
            testID="switch-haptics"
          />
        }
      />
    </SettingsGroup>
  );
}

const styles = StyleSheet.create((theme) => ({
  looks: {
    flexDirection: 'row',
    gap: theme.space.sm,
    padding: theme.space.md,
    borderBottomWidth: theme.size.hairline,
    borderColor: theme.colors.border,
  },
  lookCard: (selected: boolean) => ({
    flex: 1,
    gap: theme.space.xs,
    padding: theme.space.sm,
    borderRadius: theme.radius.md,
    borderWidth: theme.size.focusRing,
    borderColor: selected ? theme.colors.accent : theme.colors.border,
  }),
  preview: (canvas: string) => ({
    height: theme.size.avatarLg * 1.4,
    borderRadius: theme.radius.sm,
    backgroundColor: canvas,
    padding: theme.space.sm,
    justifyContent: 'center',
  }),
  previewCard: (surface: string, radius: number) => ({
    backgroundColor: surface,
    borderRadius: radius,
    padding: theme.space.xs,
    gap: theme.space.xxs,
  }),
  previewBar: (color: string, units: number) => ({
    height: theme.space.xs,
    width: `${units * 30}%` as `${number}%`,
    borderRadius: theme.radius.pill,
    backgroundColor: color,
  }),
}));
