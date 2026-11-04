import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { SpaceTokens } from '../tokens';

type Gap = keyof SpaceTokens;

interface StackProps {
  children?: ReactNode;
  gap?: Gap;
  align?: 'flex-start' | 'center' | 'flex-end' | 'stretch' | 'baseline';
  justify?: 'flex-start' | 'center' | 'flex-end' | 'space-between' | 'space-around';
  wrap?: boolean;
  flex?: number;
  style?: StyleProp<ViewStyle>;
}

/** Vertical stack with theme spacing. */
export function VStack({ children, gap = 'none', align, justify, flex, style }: StackProps) {
  return <View style={[styles.stack('column', gap, align, justify, false, flex), style]}>{children}</View>;
}

/** Horizontal stack with theme spacing. */
export function HStack({ children, gap = 'sm', align = 'center', justify, wrap = false, flex, style }: StackProps) {
  return <View style={[styles.stack('row', gap, align, justify, wrap, flex), style]}>{children}</View>;
}

/** Flexible empty space. */
export function Spacer() {
  return <View style={styles.spacer} />;
}

export function Divider({ inset = 'none' }: { inset?: Gap }) {
  return <View style={styles.divider(inset)} />;
}

const styles = StyleSheet.create((theme) => ({
  stack: (
    direction: 'row' | 'column',
    gap: Gap,
    align: StackProps['align'],
    justify: StackProps['justify'],
    wrap: boolean,
    flex: number | undefined,
  ) => ({
    flexDirection: direction,
    gap: theme.space[gap],
    alignItems: align,
    justifyContent: justify,
    flexWrap: wrap ? 'wrap' : 'nowrap',
    flex,
  }),
  spacer: { flex: 1 },
  divider: (inset: Gap) => ({
    height: theme.size.hairline,
    backgroundColor: theme.colors.border,
    marginLeft: theme.space[inset],
  }),
}));
