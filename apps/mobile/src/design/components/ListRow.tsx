import type { ReactNode } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Icon } from './Icon';
import { PressableScale } from './PressableScale';
import { Text } from './Text';

export interface ListRowProps {
  title: string;
  subtitle?: string;
  /** Icon, avatar or category badge on the left. */
  leading?: ReactNode;
  /** Amount or control on the right. */
  trailing?: ReactNode;
  /** Small text under the trailing element (date, account). */
  trailingCaption?: string;
  onPress?: () => void;
  onLongPress?: () => void;
  showChevron?: boolean;
  /** Dim the row (greyed-out connectors, excluded items). */
  dimmed?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}

/** Standard row: leading visual, title and subtitle, trailing amount. Height follows the look. */
export function ListRow({
  title,
  subtitle,
  leading,
  trailing,
  trailingCaption,
  onPress,
  onLongPress,
  showChevron = false,
  dimmed = false,
  accessibilityLabel,
  testID,
}: ListRowProps) {
  const content = (
    <View style={styles.row(dimmed)} testID={testID}>
      {leading ? <View style={styles.leading}>{leading}</View> : null}
      <View style={styles.body}>
        <Text variant="bodyStrong" numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="caption" tone="muted" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing || trailingCaption ? (
        <View style={styles.trailing}>
          {trailing}
          {trailingCaption ? (
            <Text variant="caption" tone="muted" numberOfLines={1}>
              {trailingCaption}
            </Text>
          ) : null}
        </View>
      ) : null}
      {showChevron ? <Icon name="chevron-right" size="sm" tone="faint" /> : null}
    </View>
  );
  if (!onPress && !onLongPress) return content;
  return (
    <PressableScale
      onPress={onPress}
      onLongPress={onLongPress}
      pressHaptic="tap"
      accessibilityLabel={accessibilityLabel ?? title}
    >
      {content}
    </PressableScale>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: (dimmed: boolean) => ({
    minHeight: theme.size.rowHeight,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.md,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.sm,
    opacity: dimmed ? 0.45 : 1,
  }),
  leading: { alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, gap: theme.space.xxs },
  trailing: { alignItems: 'flex-end', gap: theme.space.xxs, maxWidth: '50%' },
}));
