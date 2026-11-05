import { Text as RNText, type TextProps as RNTextProps } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { AppTheme } from '../themes';
import type { TypeVariant } from '../tokens';

export type TextTone =
  | 'default'
  | 'muted'
  | 'faint'
  | 'accent'
  | 'income'
  | 'spending'
  | 'netWorth'
  | 'pending'
  | 'danger'
  | 'inverse'
  | 'onAccent';

export interface TextProps extends RNTextProps {
  variant?: TypeVariant;
  tone?: TextTone;
  /** Tabular figures, for anything that lines up in columns. MoneyText always sets it. */
  numeric?: boolean;
  align?: 'left' | 'center' | 'right';
  uppercase?: boolean;
}

export function toneColor(theme: AppTheme, tone: TextTone): string {
  const c = theme.colors;
  switch (tone) {
    case 'muted':
      return c.textMuted;
    case 'faint':
      return c.textFaint;
    case 'accent':
      return c.accent;
    case 'income':
      return c.income;
    case 'spending':
      return c.spending;
    case 'netWorth':
      return c.netWorth;
    case 'pending':
      return c.pending;
    case 'danger':
      return c.danger;
    case 'inverse':
      return c.textInverse;
    case 'onAccent':
      return c.onAccent;
    default:
      return c.text;
  }
}

export function Text({
  variant = 'body',
  tone = 'default',
  numeric = false,
  align,
  uppercase = false,
  style,
  ...rest
}: TextProps) {
  return (
    <RNText {...rest} style={[styles.text(variant, tone, numeric, align, uppercase), style]} />
  );
}

const styles = StyleSheet.create((theme) => ({
  text: (
    variant: TypeVariant,
    tone: TextTone,
    numeric: boolean,
    align: 'left' | 'center' | 'right' | undefined,
    uppercase: boolean,
  ) => ({
    ...theme.type[variant],
    color: toneColor(theme, tone),
    fontVariant: numeric ? ['tabular-nums'] : [],
    textAlign: align,
    textTransform: uppercase ? 'uppercase' : 'none',
  }),
}));
