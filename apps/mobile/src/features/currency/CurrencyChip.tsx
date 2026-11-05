import { useState } from 'react';
import { View } from 'react-native';
import { DISPLAY_CURRENCY_MODES, formatRate, type DisplayCurrencyMode } from '@manaclaude/shared';
import { StyleSheet } from 'react-native-unistyles';
import { BottomSheet } from '../../design/components/BottomSheet';
import { Chip, SegmentedControl } from '../../design/components/Controls';
import { Text } from '../../design/components/Text';
import { haptic } from '../../design/haptics';
import { updateSettings } from '../../data/settingsStore';
import { timeAgo } from '../accounts/health';
import { useMoneyDisplay } from './useMoneyDisplay';

const SOURCE_LABEL: Record<string, string> = {
  openexchangerates: 'Open Exchange Rates',
  frankfurter_ecb: 'ECB via Frankfurter',
};

/** The hourly rate fetch should never be older than this before we call it stale. */
const STALE_AFTER_MS = 3 * 60 * 60 * 1000;

function chipLabel(mode: DisplayCurrencyMode, primary: string, secondary: string): string {
  return mode === 'BOTH' ? `${primary} + ${secondary}` : mode === 'NATIVE' ? 'Native' : mode;
}

const MODE_HELP: Record<DisplayCurrencyMode, string> = {
  USD: 'Everything converted to US dollars.',
  INR: 'Everything converted to Indian rupees.',
  BOTH: 'Main currency large, the other underneath.',
  NATIVE: 'Each account in its own currency; totals use the main currency.',
};

/**
 * Header chip (session A owns this file): tap cycles USD, INR, Both, Native;
 * long-press shows the current rate and when it was fetched.
 */
export function CurrencyChip() {
  const display = useMoneyDisplay();
  const [open, setOpen] = useState(false);
  const [stale, setStale] = useState(false);
  const next = () => {
    const i = DISPLAY_CURRENCY_MODES.indexOf(display.mode);
    updateSettings({
      displayCurrencyMode: DISPLAY_CURRENCY_MODES[(i + 1) % DISPLAY_CURRENCY_MODES.length],
    });
  };
  const rate = display.latestRate;
  const label = chipLabel(display.mode, display.primaryCurrency, display.secondaryCurrency);
  return (
    <>
      <Chip
        label={label}
        icon="arrow-left-right"
        onPress={next}
        onLongPress={() => {
          haptic('longPress');
          setStale(rate ? Date.now() - Date.parse(rate.asOf) > STALE_AFTER_MS : false);
          setOpen(true);
        }}
        accessibilityLabel={`Display currency ${label}. Tap to change, long-press for the rate.`}
        testID="currency-chip"
      />
      <BottomSheet
        visible={open}
        onClose={() => setOpen(false)}
        title="Exchange rate"
        testID="rate-sheet"
      >
        <View style={styles.body}>
          {rate ? (
            <>
              <Text variant="amountLarge" numeric align="center" testID="rate-value">
                {formatRate(rate.rate, display.primaryCurrency, display.secondaryCurrency)}
              </Text>
              <Text variant="caption" tone="muted" align="center" testID="rate-fetched">
                {`Fetched ${timeAgo(rate.asOf)} (${new Date(rate.asOf).toLocaleString()}) from ${
                  SOURCE_LABEL[rate.source] ?? rate.source
                }`}
              </Text>
              {stale ? (
                <Text variant="caption" tone="pending" align="center">
                  This rate is older than the hourly refresh should allow. Balances may be slightly
                  off until the next fetch.
                </Text>
              ) : null}
            </>
          ) : (
            <Text tone="muted" align="center">
              No rate yet.
            </Text>
          )}
          <SegmentedControl
            accessibilityLabel="Display currency"
            value={display.mode}
            onChange={(displayCurrencyMode) => updateSettings({ displayCurrencyMode })}
            options={DISPLAY_CURRENCY_MODES.map((m) => ({
              value: m,
              label: m === 'BOTH' ? 'Both' : m === 'NATIVE' ? 'Native' : m,
            }))}
          />
          <Text variant="caption" tone="muted" align="center">
            {MODE_HELP[display.mode]}
          </Text>
          <Text variant="caption" tone="faint" align="center">
            Balances use the latest rate. Spending uses the rate on the date of each transaction.
            Linked transfers keep the rate you actually got.
          </Text>
        </View>
      </BottomSheet>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.space.md, paddingVertical: theme.space.md },
}));
