import type { ReactNode } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Card } from '../../design/components/Card';
import { SectionHeader } from '../../design/components/Decor';
import { Text } from '../../design/components/Text';

/** One setting: label and help text on the left, the control on the right or below. */
export function SettingsRow({
  label,
  description,
  control,
  below = false,
}: {
  label: string;
  description?: string;
  control: ReactNode;
  /** Put the control under the text (segmented controls). */
  below?: boolean;
}) {
  return (
    <View style={styles.row(below)}>
      <View style={styles.text}>
        <Text variant="bodyStrong">{label}</Text>
        {description ? (
          <Text variant="caption" tone="muted">
            {description}
          </Text>
        ) : null}
      </View>
      {control}
    </View>
  );
}

export function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View>
      <SectionHeader title={title} />
      <Card padding="none">{children}</Card>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: (below: boolean) => ({
    flexDirection: below ? 'column' : 'row',
    alignItems: below ? 'stretch' : 'center',
    gap: theme.space.md,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.md,
    borderBottomWidth: theme.size.hairline,
    borderColor: theme.colors.border,
  }),
  text: { flex: 1, gap: theme.space.xxs },
}));
