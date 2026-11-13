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
 * by itself when the login is done; on the web it opens in a new tab and you
 * tap Done here.
 *
 * Only a login that came back as finished is completed. A window that was
 * closed or cancelled completes nothing by itself: a repair stays as it was,
 * with its error, and a new link is finished only if you say you finished it.
 */
export function BrowserFlow({ connector, connectionId, onLinked }: FlowProps) {
  const isKite = connector === 'zerodha_kite';
  const repair = Boolean(connectionId);
  const [linkId, setLinkId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The phone's browser window was closed without the login reporting back.
  const [closed, setClosed] = useState(false);

  const doneLabel = Platform.OS === 'web' ? 'Done' : 'I finished in SnapTrade';

  const finish = async (id: string | null) => {
    setError(null);
    if (isKite) {
      // The Worker's callback saved the day's token on the Zerodha connection.
      await refreshDataset();
      const conn = getFinance().connections.find((c) => c.connectorId === 'zerodha_kite');
      if (conn) onLinked([conn.id], repair);
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
          ? `No new brokerage yet. Finish connecting in the SnapTrade window, then tap ${doneLabel}.`
          : errorText(e),
      );
    }
  };

  const finishByHand = async (id: string) => {
    setFinishing(true);
    try {
      await finish(id);
    } finally {
      setFinishing(false);
    }
  };

  const open = async () => {
    setBusy(true);
    setError(null);
    setClosed(false);
    try {
      const start = isKite
        ? await linkApi.kiteStart(connectionId, linkReturnUrl())
        : await linkApi.snaptradeStart(connectionId, linkReturnUrl());
      setLinkId(start.linkId);
      const back = await openLinkPage(start.url);
      if (back.result === 'error') setError(back.message ?? 'The login did not finish. Try again.');
      else if (back.result === 'ok') await finish(start.linkId);
      // Closed or cancelled. On the web that only means the tab was opened.
      else if (Platform.OS !== 'web') setClosed(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const provider = isKite ? 'Zerodha' : 'SnapTrade';
  // After a closed window, only a new SnapTrade link may be finished by hand:
  // the Worker then looks for a brokerage that is really new. A repair has
  // nothing to check a cancelled login against, so it is not offered.
  const offerDone = linkId !== null && (Platform.OS === 'web' || (closed && !isKite && !repair));

  return (
    <Card>
      <VStack gap="md">
        <Text variant="body">
          {isKite
            ? 'Log in to Zerodha on its own page. Zerodha ends the login every morning, so this is a daily tap: Repair on the Accounts screen brings you straight here.'
            : 'SnapTrade opens its connection page. Pick your brokerage (Robinhood, E*TRADE, Zerodha...) and sign in there. Each brokerage uses one of your 20 free connections.'}
        </Text>
        {closed ? (
          <Text variant="body" testID="browser-closed">
            {repair
              ? `The ${provider} window was closed before the login finished, so nothing was changed. This connection still needs repair. Open ${provider} again to try once more.`
              : isKite
                ? 'The Zerodha window was closed before the login finished, so nothing was saved. Log in again to try once more.'
                : 'The SnapTrade window was closed before it reported back, so nothing was saved. If you did finish connecting there, tap I finished in SnapTrade. Otherwise open it again.'}
          </Text>
        ) : null}
        {error ? (
          <Text variant="caption" tone="danger" testID="link-error">
            {error}
          </Text>
        ) : null}
        <Button
          label={isKite ? 'Log in to Zerodha' : 'Open SnapTrade'}
          icon="external-link"
          loading={busy}
          disabled={finishing}
          onPress={open}
          testID="browser-open"
        />
        {offerDone && linkId ? (
          <Button
            label={doneLabel}
            variant="secondary"
            loading={finishing}
            disabled={busy}
            onPress={() => void finishByHand(linkId)}
            testID="browser-done"
          />
        ) : null}
      </VStack>
    </Card>
  );
}
