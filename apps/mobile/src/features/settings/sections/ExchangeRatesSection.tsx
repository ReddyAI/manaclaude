import { formatRate } from '@manaclaude/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../../design/components/Button';
import { Text } from '../../../design/components/Text';
import { VStack } from '../../../design/components/Layout';
import { errorText, isSuperseded } from '../../../data/backend/client';
import { isBackendReady, useBackendConfig } from '../../../data/backend/config';
import { useBackendStatus } from '../../../data/backend/status';
import { scheduleRefresh } from '../../../data/backend/sync';
import { useFinance } from '../../../data/store';
import { olderThanRatesText, rateRanges, rateRangeText } from '../../currency/rateRanges';
import { useMoneyDisplay } from '../../currency/useMoneyDisplay';
import {
  refreshRates,
  refreshText,
  SOURCE_LABEL,
  usdInrStore,
  utcText,
} from '../../currency/fxApi';
import { SettingsGroup, SettingsRow } from '../SettingsRow';

/**
 * The USD to INR rate the Worker has (GET /v1/fx/latest) and a way to fetch
 * the latest rates now instead of waiting for the hourly job (POST
 * /v1/fx/refresh).
 */
export function ExchangeRatesSection() {
  const config = useBackendConfig();
  const ready = isBackendReady(config);
  const { value: latest, error } = usdInrStore.use();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; failed: boolean } | null>(null);
  const sending = useRef(false);
  const [shownScope, setShownScope] = useState(config.scope);
  if (shownScope !== config.scope) {
    setShownScope(config.scope);
    setResult(null);
  }

  useEffect(() => {
    if (ready) void usdInrStore.load();
  }, [ready, config.scope]);

  const data = useFinance();
  const display = useMoneyDisplay();
  const backend = useBackendStatus();
  const reportCurrencies = useMemo(
    () =>
      display.mode === 'BOTH'
        ? [display.primaryCurrency, display.secondaryCurrency]
        : [display.reportCurrency],
    [display.mode, display.primaryCurrency, display.secondaryCurrency, display.reportCurrency],
  );
  const ranges = useMemo(() => rateRanges(data, reportCurrencies), [data, reportCurrencies]);

  const refresh = async () => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setResult(null);
    try {
      const r = await refreshRates();
      setResult({ text: refreshText(r), failed: r.openExchangeRates + r.frankfurter === 0 });
      if (r.openExchangeRates + r.frankfurter > 0) scheduleRefresh();
      void usdInrStore.load();
    } catch (e) {
      if (!isSuperseded(e)) setResult({ text: errorText(e), failed: true });
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  return (
    <SettingsGroup title="Exchange rates">
      <SettingsRow
        label={
          !ready
            ? 'Needs the backend'
            : latest?.rate
              ? formatRate(latest.rate, 'USD', 'INR')
              : latest
                ? 'No USD to INR rate stored yet'
                : 'USD to INR'
        }
        description={
          !ready
            ? 'Rates are fetched by your Worker. Enter its address and token in Settings, Backend.'
            : latest?.asOf
              ? `Published ${utcText(latest.asOf)}${latest.source ? ` by ${SOURCE_LABEL[latest.source] ?? latest.source}` : ''}. The Worker fetches new rates every hour.`
              : error
                ? `The rate could not be loaded. ${error}`
                : 'The Worker fetches new rates every hour.'
        }
        below
        control={
          ready ? (
            <VStack gap="sm">
              <Button
                label="Refresh rates now"
                icon="refresh-cw"
                size="sm"
                variant="secondary"
                loading={busy}
                onPress={() => void refresh()}
                testID="fx-refresh"
              />
              {result ? (
                <Text
                  variant="caption"
                  tone={result.failed ? 'danger' : 'muted'}
                  testID="fx-refresh-result"
                >
                  {result.text}
                </Text>
              ) : null}
            </VStack>
          ) : null
        }
      />
      {ready ? (
        <SettingsRow
          label="How far back day rates go"
          description={
            backend.mode === 'live'
              ? 'Reports convert each transaction with the rate on its day, or the nearest one your Worker has.'
              : "Shown once your Worker's data has loaded; the app is showing sample data now."
          }
          below
          control={
            backend.mode === 'live' ? (
              <VStack gap="sm" testID="rate-ranges">
                {ranges.map((r) => {
                  const older = olderThanRatesText(r);
                  return (
                    <VStack key={r.currency} gap="xxs" testID={`rate-range-${r.currency}`}>
                      <Text variant="caption" tone={r.noRate ? 'pending' : 'default'}>
                        {rateRangeText(r, display.reportCurrency)}
                      </Text>
                      {older ? (
                        <Text
                          variant="caption"
                          tone="muted"
                          testID={`rate-range-older-${r.currency}`}
                        >
                          {older}
                        </Text>
                      ) : null}
                    </VStack>
                  );
                })}
              </VStack>
            ) : null
          }
        />
      ) : null}
    </SettingsGroup>
  );
}
