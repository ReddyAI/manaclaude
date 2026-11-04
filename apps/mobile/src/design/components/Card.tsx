import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { SpaceTokens } from '../tokens';
import { PressableScale } from './PressableScale';

export interface CardProps {
  children: ReactNode;
  padding?: keyof SpaceTokens;
  onPress?: () => void;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  /** Sunken cards sit inside other cards. */
  tone?: 'surface' | 'sunken' | 'accent';
}

/** Surface container. Raised, flat or outlined depending on the look. */
export function Card({ children, padding = 'lg', onPress, accessibilityLabel, style, tone = 'surface' }: CardProps) {
  const body = <View style={[styles.card(padding, tone), style]}>{children}</View>;
  if (!onPress) return body;
  return (
    <PressableScale onPress={onPress} accessibilityLabel={accessibilityLabel} pressHaptic="tap">
      {body}
    </PressableScale>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: (padding: keyof SpaceTokens, tone: 'surface' | 'sunken' | 'accent') => ({
    backgroundColor:
      tone === 'sunken' ? theme.colors.surfaceSunken : tone === 'accent' ? theme.colors.accentMuted : theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: theme.space[padding],
    borderWidth: theme.layout.card === 'outlined' && tone === 'surface' ? theme.size.borderWidth : 0,
    borderColor: theme.colors.border,
    boxShadow:
      theme.layout.card === 'raised' && tone === 'surface'
        ? `0px ${theme.layout.shadowOffsetY}px ${theme.layout.shadowRadius}px ${theme.colors.shadow}`
        : undefined,
  }),
}));
