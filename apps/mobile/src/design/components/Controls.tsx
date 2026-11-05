import { useEffect, useState } from 'react';
import { Pressable, TextInput, View, type TextInputProps } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { haptic } from '../haptics';
import { Icon, type IconName } from './Icon';
import { PressableScale } from './PressableScale';
import { Text } from './Text';

// ---------------------------------------------------------------------------
// Switch: Toggle_On / Toggle_Off haptics.
// ---------------------------------------------------------------------------

export interface SwitchProps {
  value: boolean;
  onValueChange: (value: boolean) => void;
  accessibilityLabel: string;
  disabled?: boolean;
  testID?: string;
}

export function Switch({
  value,
  onValueChange,
  accessibilityLabel,
  disabled = false,
  testID,
}: SwitchProps) {
  const { theme } = useUnistyles();
  const travel = theme.size.switchWidth - theme.size.switchHeight;
  const x = useSharedValue(value ? travel : 0);
  useEffect(() => {
    x.set(withSpring(value ? travel : 0, theme.motion.spring));
  }, [value, travel, theme.motion.spring, x]);
  const knob = useAnimatedStyle(() => ({ transform: [{ translateX: x.get() }] }));
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      testID={testID}
      hitSlop={8}
      onPress={() => {
        haptic(value ? 'toggleOff' : 'toggleOn');
        onValueChange(!value);
      }}
    >
      <View style={styles.track(value, disabled)}>
        <Animated.View style={knob}>
          <View style={styles.knob} />
        </Animated.View>
      </View>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// SegmentedControl
// ---------------------------------------------------------------------------

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
}

export interface SegmentedControlProps<T extends string> {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  accessibilityLabel: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
}: SegmentedControlProps<T>) {
  return (
    <View
      style={styles.segmented}
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
    >
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={o.label}
            onPress={() => {
              if (!selected) {
                haptic('selection');
                onChange(o.value);
              }
            }}
            style={styles.segment(selected)}
          >
            {o.icon ? <Icon name={o.icon} size="sm" tone={selected ? 'default' : 'muted'} /> : null}
            <Text variant="label" tone={selected ? 'default' : 'muted'} numberOfLines={1}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Chip and Badge
// ---------------------------------------------------------------------------

export interface ChipProps {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  icon?: IconName;
  accessibilityLabel?: string;
  testID?: string;
}

export function Chip({
  label,
  selected = false,
  onPress,
  onLongPress,
  icon,
  accessibilityLabel,
  testID,
}: ChipProps) {
  return (
    <PressableScale
      onPress={onPress}
      onLongPress={onLongPress}
      pressHaptic="selection"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected }}
      testID={testID}
    >
      <View style={styles.chip(selected)}>
        {icon ? <Icon name={icon} size="xs" tone={selected ? 'onAccent' : 'muted'} /> : null}
        <Text variant="label" tone={selected ? 'onAccent' : 'default'} numeric>
          {label}
        </Text>
      </View>
    </PressableScale>
  );
}

export type BadgeTone =
  'neutral' | 'accent' | 'income' | 'spending' | 'pending' | 'danger' | 'netWorth';

export function Badge({
  label,
  tone = 'neutral',
  icon,
}: {
  label: string;
  tone?: BadgeTone;
  icon?: IconName;
}) {
  const textTone = tone === 'neutral' ? 'muted' : tone;
  return (
    <View style={styles.badge(tone)}>
      {icon ? <Icon name={icon} size="xs" tone={textTone} /> : null}
      <Text variant="micro" tone={textTone} uppercase>
        {label}
      </Text>
    </View>
  );
}

/** Small coloured dot (legend, status). Pass a theme colour. */
export function Dot({ color }: { color: string }) {
  return <View style={styles.dot(color)} />;
}

// ---------------------------------------------------------------------------
// ProgressBar
// ---------------------------------------------------------------------------

export interface ProgressBarProps {
  /** 0 to 1; above 1 shows as over budget. */
  value: number;
  /** Colour of the fill; pass a theme colour. Defaults to accent, danger when over. */
  color?: string;
  /** Optional marker (0 to 1), e.g. how far through the month we are. */
  marker?: number;
  accessibilityLabel?: string;
}

export function ProgressBar({ value, color, marker, accessibilityLabel }: ProgressBarProps) {
  const { theme } = useUnistyles();
  const clamped = Math.max(0, Math.min(1, value));
  const width = useSharedValue(0);
  useEffect(() => {
    width.set(withTiming(clamped, { duration: theme.motion.slow }));
  }, [clamped, theme.motion.slow, width]);
  const fill = useAnimatedStyle(() => ({ width: `${width.get() * 100}%` }));
  const fillColor = value > 1 ? theme.colors.danger : (color ?? theme.colors.accent);
  return (
    <View
      style={styles.progressTrack}
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(value * 100) }}
    >
      <Animated.View style={[styles.progressFillBase, fill]}>
        <View style={styles.progressFill(fillColor)} />
      </Animated.View>
      {marker !== undefined ? (
        <View style={styles.progressMarker(Math.max(0, Math.min(1, marker)))} />
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// TextField
// ---------------------------------------------------------------------------

export interface TextFieldProps extends Omit<TextInputProps, 'style' | 'placeholderTextColor'> {
  label?: string;
  icon?: IconName;
  error?: string;
}

export function TextField({ label, icon, error, onFocus, onBlur, ...rest }: TextFieldProps) {
  const { theme } = useUnistyles();
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.fieldWrap}>
      {label ? (
        <Text variant="label" tone="muted">
          {label}
        </Text>
      ) : null}
      <View style={styles.field(focused, !!error)}>
        {icon ? <Icon name={icon} size="sm" tone="muted" /> : null}
        <TextInput
          {...rest}
          accessibilityLabel={rest.accessibilityLabel ?? label}
          placeholderTextColor={theme.colors.textFaint}
          selectionColor={theme.colors.accent}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          style={styles.input}
        />
      </View>
      {error ? (
        <Text variant="caption" tone="danger">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  track: (on: boolean, disabled: boolean) => ({
    width: theme.size.switchWidth,
    height: theme.size.switchHeight,
    borderRadius: theme.radius.pill,
    padding: theme.space.xxs,
    justifyContent: 'center',
    backgroundColor: on ? theme.colors.accent : theme.colors.borderStrong,
    opacity: disabled ? 0.5 : 1,
  }),
  knob: {
    width: theme.size.switchHeight - theme.space.xxs * 2,
    height: theme.size.switchHeight - theme.space.xxs * 2,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.surfaceRaised,
    boxShadow: `0px 1px 3px ${theme.colors.overlay}`,
  },
  segmented: {
    flexDirection: 'row',
    backgroundColor: theme.colors.surfaceSunken,
    borderRadius: theme.look === 'compact' ? theme.radius.md : theme.radius.pill,
    padding: theme.space.xxs,
    gap: theme.space.xxs,
  },
  segment: (selected: boolean) => ({
    flex: 1,
    minHeight: theme.size.chipHeight,
    paddingHorizontal: theme.space.sm,
    borderRadius: theme.look === 'compact' ? theme.radius.sm : theme.radius.pill,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space.xs,
    backgroundColor: selected ? theme.colors.surfaceRaised : 'transparent',
    boxShadow:
      selected && theme.scheme === 'light' ? `0px 1px 3px ${theme.colors.border}` : undefined,
  }),
  chip: (selected: boolean) => ({
    height: theme.size.chipHeight,
    paddingHorizontal: theme.space.md,
    borderRadius: theme.radius.pill,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.xs,
    backgroundColor: selected ? theme.colors.accent : theme.colors.surfaceSunken,
    borderWidth: !selected && theme.layout.card === 'outlined' ? theme.size.borderWidth : 0,
    borderColor: theme.colors.border,
  }),
  badge: (tone: BadgeTone) => ({
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: theme.space.xxs,
    height: theme.size.badgeHeight,
    paddingHorizontal: theme.space.sm,
    borderRadius: theme.radius.pill,
    backgroundColor: {
      neutral: theme.colors.surfaceSunken,
      accent: theme.colors.accentMuted,
      income: theme.colors.incomeMuted,
      spending: theme.colors.spendingMuted,
      pending: theme.colors.pendingMuted,
      danger: theme.colors.dangerMuted,
      netWorth: theme.colors.netWorthMuted,
    }[tone],
  }),
  dot: (color: string) => ({
    width: theme.size.dot,
    height: theme.size.dot,
    borderRadius: theme.radius.pill,
    backgroundColor: color,
  }),
  progressTrack: {
    height: theme.size.progressHeight,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.surfaceSunken,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  progressFillBase: { height: '100%' },
  progressFill: (color: string) => ({
    flex: 1,
    borderRadius: theme.radius.pill,
    backgroundColor: color,
  }),
  progressMarker: (at: number) => ({
    position: 'absolute',
    left: `${at * 100}%` as `${number}%`,
    width: theme.size.focusRing,
    height: '100%',
    backgroundColor: theme.colors.text,
    opacity: 0.35,
  }),
  fieldWrap: { gap: theme.space.xs },
  field: (focused: boolean, error: boolean) => ({
    minHeight: theme.size.inputHeight,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.sm,
    paddingHorizontal: theme.space.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceSunken,
    borderWidth: theme.size.focusRing / 2,
    borderColor: error ? theme.colors.danger : focused ? theme.colors.focus : 'transparent',
  }),
  input: {
    flex: 1,
    ...theme.type.body,
    color: theme.colors.text,
    paddingVertical: theme.space.sm,
    outlineWidth: 0,
  },
}));
