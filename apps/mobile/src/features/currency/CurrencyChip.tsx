import { useState } from 'react';
import { View } from 'react-native';
import { DISPLAY_CURRENCY_MODES, formatRate, type DisplayCurrencyMode } from '@manaclaude/shared';
import { StyleSheet } from 'react-native-unistyles';
import { BottomSheet } from '../../design/components/BottomSheet';
import { Chip } from '../../design/components/Controls';
import { Text } from '../../design/components/Text';
import { updateSettings } from '../../data/settingsStore';
import { useMoneyDisplay } from './useMoneyDisplay';

const LABEL: Record<DisplayCurrencyMode, string> = { USD: 'USD', INR: 'INR', BOTH: 'USD + INR', NATIVE: 'Native' };

function timeAgo(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/**
 * Header chip (session A owns this file): tap cycles USD, INR, Both, Native;
 * long-press shows the current rate and when it was fetched.
 */
export function CurrencyChip() {
  const display = useMoneyDisplay();
  const [open, setOpen] = useState(false);
  const next = () => {
    const i = DISPLAY_CURRENCY_MODES.indexOf(display.mode);
    updateSettings({ displayCurrencyMode: DISPLAY_CURRENCY_MODES[(i + 1) % DISPLAY_CURRENCY_MODES.length] });
  };
  const rate = display.latestRate;
  return (
    <>
      <Chip
        label={LABEL[display.mode]}
        icon="arrow-left-right"
        onPress={next}
        onLongPress={() => setOpen(true)}
        accessibilityLabel={`Display currency ${LABEL[display.mode]}. Tap to change, long-press for the rate.`}
        testID="currency-chip"
      />
      <BottomSheet visible={open} onClose={() => setOpen(false)} title="Exchange rate">
        <View style={styles.body}>
          {rate ? (
            <>
              <Text variant="amountLarge" numeric align="center">
                {formatRate(rate.rate, display.primaryCurrency, display.secondaryCurrency)}
              </Text>
              <Text variant="caption" tone="muted" align="center">
                {`Fetched ${timeAgo(rate.asOf)} (${new Date(rate.asOf).toLocaleString()}) from ${
                  rate.source === 'openexchangerates' ? 'Open Exchange Rates' : rate.source === 'frankfurter_ecb' ? 'ECB via Frankfurter' : rate.source
                }`}
              </Text>
            </>
          ) : (
            <Text tone="muted" align="center">
              No rate yet.
            </Text>
          )}
          <Text variant="caption" tone="faint" align="center">
            Balances use the latest rate. Spending uses the rate on each transaction's date. Linked transfers keep the rate you actually got.
          </Text>
        </View>
      </BottomSheet>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.space.md, paddingVertical: theme.space.md },
}));
