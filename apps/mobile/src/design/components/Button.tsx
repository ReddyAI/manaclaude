import { ActivityIndicator, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Icon, type IconName } from './Icon';
import { PressableScale } from './PressableScale';
import { Text, type TextTone } from './Text';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  disabled?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}

const LABEL_TONE: Record<ButtonVariant, TextTone> = {
  primary: 'onAccent',
  secondary: 'default',
  ghost: 'accent',
  danger: 'danger',
};

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  icon,
  disabled = false,
  loading = false,
  fullWidth = false,
  accessibilityLabel,
  testID,
}: ButtonProps) {
  const { theme } = useUnistyles();
  const tone = LABEL_TONE[variant];
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled || loading}
      pressHaptic="tap"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      testID={testID}
      containerStyle={fullWidth ? styles.full : undefined}
    >
      <View style={styles.button(variant, size, disabled)}>
        {loading ? (
          <ActivityIndicator
            size="small"
            color={variant === 'primary' ? theme.colors.onAccent : theme.colors.accent}
          />
        ) : icon ? (
          <Icon name={icon} size={size === 'lg' ? 'md' : 'sm'} tone={tone} />
        ) : null}
        <Text variant={size === 'sm' ? 'label' : 'bodyStrong'} tone={tone}>
          {label}
        </Text>
      </View>
    </PressableScale>
  );
}

export interface IconButtonProps {
  icon: IconName;
  onPress: () => void;
  accessibilityLabel: string;
  variant?: 'ghost' | 'secondary' | 'primary';
  size?: ButtonSize;
  tone?: TextTone;
  /** Greyed out and not pressable. */
  disabled?: boolean;
  testID?: string;
}

export function IconButton({
  icon,
  onPress,
  accessibilityLabel,
  variant = 'ghost',
  size = 'md',
  tone,
  disabled = false,
  testID,
}: IconButtonProps) {
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      pressHaptic="tap"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      testID={testID}
      hitSlop={8}
    >
      <View style={styles.iconButton(variant, size)}>
        <Icon
          name={icon}
          size={size === 'sm' ? 'sm' : 'md'}
          tone={disabled ? 'faint' : (tone ?? (variant === 'primary' ? 'onAccent' : 'default'))}
        />
      </View>
    </PressableScale>
  );
}

const styles = StyleSheet.create((theme) => ({
  full: { alignSelf: 'stretch' },
  button: (variant: ButtonVariant, size: ButtonSize, disabled: boolean) => ({
    height: { sm: theme.size.buttonSm, md: theme.size.buttonMd, lg: theme.size.buttonLg }[size],
    paddingHorizontal: size === 'sm' ? theme.space.md : theme.space.lg,
    borderRadius: theme.look === 'compact' ? theme.radius.md : theme.radius.pill,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space.sm,
    opacity: disabled ? 0.45 : 1,
    backgroundColor:
      variant === 'primary'
        ? theme.colors.accent
        : variant === 'secondary'
          ? theme.colors.surfaceSunken
          : variant === 'danger'
            ? theme.colors.dangerMuted
            : 'transparent',
    borderWidth:
      variant === 'secondary' && theme.layout.card === 'outlined' ? theme.size.borderWidth : 0,
    borderColor: theme.colors.border,
  }),
  iconButton: (variant: 'ghost' | 'secondary' | 'primary', size: ButtonSize) => {
    const dim = { sm: theme.size.buttonSm, md: theme.size.buttonMd, lg: theme.size.buttonLg }[size];
    return {
      width: dim,
      height: dim,
      borderRadius: theme.radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor:
        variant === 'primary'
          ? theme.colors.accent
          : variant === 'secondary'
            ? theme.colors.surfaceSunken
            : 'transparent',
    };
  },
}));
