import type { CurrencyCode, MinorUnits } from '@manaclaude/shared';
import { formatMoney, type FormatMoneyOptions } from '@manaclaude/shared';
import { Text, type TextProps, type TextTone } from './Text';

export type MoneySize = 'hero' | 'large' | 'medium' | 'small';

const VARIANT = {
  hero: 'amountHero',
  large: 'amountLarge',
  medium: 'amount',
  small: 'amountSmall',
} as const;

export interface MoneyTextProps extends Omit<TextProps, 'children' | 'variant'> {
  amount: MinorUnits;
  currency: CurrencyCode;
  size?: MoneySize;
  /**
   * 'flow' colours money in green and money out in the default text colour
   * (Copilot style); 'signed' colours out red too; 'none' uses `tone`.
   */
  colorize?: 'none' | 'flow' | 'signed';
  format?: FormatMoneyOptions;
}

/** Money with Inter tabular figures. Every amount on screen goes through this. */
export function MoneyText({
  amount,
  currency,
  size = 'medium',
  colorize = 'none',
  tone,
  format,
  ...rest
}: MoneyTextProps) {
  let resolved: TextTone = tone ?? 'default';
  if (colorize !== 'none' && amount > 0) resolved = 'income';
  if (colorize === 'signed' && amount < 0) resolved = 'spending';
  const sign = format?.sign ?? (colorize === 'flow' && amount > 0 ? 'always' : 'negative');
  return (
    <Text {...rest} variant={VARIANT[size]} tone={resolved} numeric>
      {formatMoney(amount, currency, { ...format, sign })}
    </Text>
  );
}
