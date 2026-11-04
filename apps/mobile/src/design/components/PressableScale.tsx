import type { ReactNode } from 'react';
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';
import { haptic, type HapticEvent } from '../haptics';

export interface PressableScaleProps extends Omit<PressableProps, 'style' | 'children'> {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Style of the animated wrapper (use for flex: 1 in rows). */
  containerStyle?: StyleProp<ViewStyle>;
  /** Haptic fired on press; none by default. */
  pressHaptic?: HapticEvent;
}

/** Pressable that shrinks slightly while held, timed by the theme's motion tokens. */
export function PressableScale({
  children,
  style,
  containerStyle,
  pressHaptic,
  onPressIn,
  onPressOut,
  onPress,
  disabled,
  ...rest
}: PressableScaleProps) {
  const { theme } = useUnistyles();
  const scale = useSharedValue(1);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <Animated.View style={[containerStyle, animated]}>
      <Pressable
        {...rest}
        disabled={disabled}
        accessibilityRole={rest.accessibilityRole ?? 'button'}
        onPressIn={(e) => {
          scale.value = withTiming(theme.motion.pressScale, { duration: theme.motion.fast });
          onPressIn?.(e);
        }}
        onPressOut={(e) => {
          scale.value = withTiming(1, { duration: theme.motion.fast });
          onPressOut?.(e);
        }}
        onPress={(e) => {
          if (pressHaptic) haptic(pressHaptic);
          onPress?.(e);
        }}
        style={style}
      >
        {children}
      </Pressable>
    </Animated.View>
  );
}
