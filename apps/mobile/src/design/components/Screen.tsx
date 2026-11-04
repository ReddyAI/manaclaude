import type { ReactElement, ReactNode } from 'react';
import { ScrollView, View, type RefreshControlProps } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Text } from './Text';

export interface ScreenProps {
  title: string;
  subtitle?: string;
  /** Right side of the header: the currency chip and screen actions. */
  actions?: ReactNode;
  children: ReactNode;
  /** false when the screen renders its own list (FlashList). */
  scroll?: boolean;
  refreshControl?: ReactElement<RefreshControlProps>;
  /** Floating element above the content (the cash quick-add button). */
  overlay?: ReactNode;
  testID?: string;
}

/**
 * Top-level screen: safe-area padding, large title header, centred content
 * with a max width on big screens.
 */
export function Screen({ title, subtitle, actions, children, scroll = true, refreshControl, overlay, testID }: ScreenProps) {
  const header = (
    <View style={styles.header}>
      <View style={styles.titleBlock}>
        <Text variant="title" accessibilityRole="header" numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="caption" tone="muted" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {actions ? <View style={styles.actions}>{actions}</View> : null}
    </View>
  );
  return (
    <View style={styles.root} testID={testID}>
      {scroll ? (
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          refreshControl={refreshControl}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.column}>
            {header}
            {children}
          </View>
        </ScrollView>
      ) : (
        <View style={styles.fixed}>
          <View style={styles.column}>{header}</View>
          <View style={styles.fill}>{children}</View>
        </View>
      )}
      {overlay}
    </View>
  );
}

const styles = StyleSheet.create((theme, rt) => ({
  root: { flex: 1, backgroundColor: theme.colors.canvas },
  scrollContent: {
    paddingTop: rt.insets.top + theme.space.sm,
    paddingBottom: rt.insets.bottom + theme.size.tabBarHeight + theme.space.xxl,
    alignItems: 'center',
  },
  fixed: { flex: 1, paddingTop: rt.insets.top + theme.space.sm, alignItems: 'center' },
  column: {
    width: '100%',
    maxWidth: theme.size.maxContentWidth,
    gap: theme.space.md,
    paddingHorizontal: {
      xs: theme.space.lg,
      md: theme.space.xl,
    },
  },
  fill: { flex: 1, width: '100%', maxWidth: theme.size.maxContentWidth },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.md,
    paddingVertical: theme.space.sm,
  },
  titleBlock: { flex: 1, gap: theme.space.xxs },
  actions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.sm },
}));
