import { View } from 'react-native';
import type { CurrencyCode, LocalDate, MinorUnits, TransferLink } from '@manaclaude/shared';
import { StyleSheet } from 'react-native-unistyles';
import { MoneyText, type MoneySize, type MoneyTextProps } from '../../design/components/MoneyText';
import { useMoneyDisplay } from './useMoneyDisplay';

export interface AmountProps {
  amount: MinorUnits;
  currency: CurrencyCode;
  /** Transaction date: converts with that day's rate. Omit for balances (latest rate). */
  date?: LocalDate;
  /** A linked cross-currency transfer converts with its own rate. */
  link?: TransferLink | null;
  size?: MoneySize;
  colorize?: MoneyTextProps['colorize'];
  tone?: MoneyTextProps['tone'];
  format?: MoneyTextProps['format'];
  align?: 'left' | 'right' | 'center';
  testID?: string;
}

const SUB_SIZE: Record<MoneySize, MoneySize> = {
  hero: 'medium',
  large: 'small',
  medium: 'small',
  small: 'small',
};

/**
 * An amount shown in the header's display currency. In Both mode the
 * primary currency is large with the other currency underneath.
 */
export function Amount({
  amount,
  currency,
  date,
  link,
  size = 'medium',
  colorize,
  tone,
  format,
  align = 'right',
  testID,
}: AmountProps) {
  const display = useMoneyDisplay();
  const { main, sub } = display.present(amount, currency, date, link);
  return (
    <View style={styles.wrap(align)} testID={testID}>
      <MoneyText
        amount={main.amount}
        currency={main.currency}
        size={size}
        colorize={colorize}
        tone={tone}
        format={format}
      />
      {sub ? (
        <MoneyText
          amount={sub.amount}
          currency={sub.currency}
          size={SUB_SIZE[size]}
          tone="muted"
          format={{ ...format, sign: 'negative' }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  wrap: (align: 'left' | 'right' | 'center') => ({
    alignItems: align === 'left' ? 'flex-start' : align === 'center' ? 'center' : 'flex-end',
  }),
}));

export interface DualAmountProps extends Omit<
  AmountProps,
  'amount' | 'currency' | 'date' | 'link'
> {
  /** Total in the report currency. */
  main: MinorUnits;
  /** The same total computed in the second currency (BOTH mode), or null. */
  sub?: { amount: MinorUnits; currency: CurrencyCode } | null;
}

/**
 * A total that was already computed per shown currency (see `display.dual`).
 * Shows the main currency large and, in Both mode, the other one underneath.
 */
export function DualAmount({
  main,
  sub,
  size = 'medium',
  colorize,
  tone,
  format,
  align = 'right',
  testID,
}: DualAmountProps) {
  const display = useMoneyDisplay();
  return (
    <View style={styles.wrap(align)} testID={testID}>
      <MoneyText
        amount={main}
        currency={display.reportCurrency}
        size={size}
        colorize={colorize}
        tone={tone}
        format={format}
      />
      {sub ? (
        <MoneyText
          amount={sub.amount}
          currency={sub.currency}
          size={SUB_SIZE[size]}
          tone="muted"
          format={{ ...format, sign: 'negative' }}
        />
      ) : null}
    </View>
  );
}
