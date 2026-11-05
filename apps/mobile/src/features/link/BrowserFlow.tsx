import { useState } from 'react';
import { Platform } from 'react-native';
import { Button } from '../../design/components/Button';
import { Card } from '../../design/components/Card';
import { VStack } from '../../design/components/Layout';
import { Text } from '../../design/components/Text';
import { BackendError, errorText } from '../../data/backend/client';
import { refreshDataset } from '../../data/backend/sync';
import { getFinance } from '../../data/store';
import { linkReturnUrl, openLinkPage } from './browser';
import { linkApi } from './linkApi';
import type { FlowProps } from './types';

/**
 * SnapTrade and Zerodha Kite: a page in the browser (SnapTrade's connection
 * portal, Kite's login), then back to the app. On the phone the browser closes
 * by itself; on the web it opens in a new tab and you tap Done here.
 */
export function BrowserFlow({ connector, connectionId, onLinked }: FlowProps) {
  const isKite = connector === 'zerodha_kite';
  const [linkId, setLinkId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = async (id: string | null) => {
    if (isKite) {
      // The Worker's callback saved the day's token on the Zerodha connection.
      await refreshDataset();
      const conn = getFinance().connections.find((c) => c.connectorId === 'zerodha_kite');
      if (conn) onLinked([conn.id], Boolean(connectionId));
      else setError('Zerodha did not finish the login. Try again.');
      return;
    }
    if (!id) return;
    try {
      const done = await linkApi.snaptradeComplete(id);
      onLinked(done.connectionIds, done.repaired);
    } catch (e) {
      setError(
        e instanceof BackendError && e.code === 'not_finished'
          ? 'No new brokerage yet. Finish connecting in the SnapTrade window, then tap Done.'
          : errorText(e),
      );
    }
  };

  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      const start = isKite
        ? await linkApi.kiteStart(connectionId, linkReturnUrl())
        : await linkApi.snaptradeStart(connectionId, linkReturnUrl());
      setLinkId(start.linkId);
      const back = await openLinkPage(start.url);
      if (back.result === 'error') setError(back.message ?? 'The login did not finish. Try again.');
      else if (back.result === 'ok' || (!isKite && Platform.OS !== 'web'))
        await finish(start.linkId);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <VStack gap="md">
        <Text variant="body">
          {isKite
            ? 'Log in to Zerodha on its own page. Zerodha ends the login every morning, so this is a daily tap: Repair on the Accounts screen brings you straight here.'
            : 'SnapTrade opens its connection page. Pick your brokerage (Robinhood, E*TRADE, Zerodha...) and sign in there. Each brokerage uses one of your 20 free connections.'}
        </Text>
        {error ? (
          <Text variant="caption" tone="danger" testID="link-error">
            {error}
          </Text>
        ) : null}
        <Button
          label={isKite ? 'Log in to Zerodha' : 'Open SnapTrade'}
          icon="external-link"
          loading={busy}
          onPress={open}
          testID="browser-open"
        />
        {linkId && Platform.OS === 'web' ? (
          <Button
            label="Done"
            variant="secondary"
            onPress={() => void finish(linkId)}
            testID="browser-done"
          />
        ) : null}
      </VStack>
    </Card>
  );
}
