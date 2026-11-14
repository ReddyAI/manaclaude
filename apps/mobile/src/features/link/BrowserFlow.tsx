import { useState } from 'react';
import { Platform } from 'react-native';
import { Button } from '../../design/components/Button';
import { Card } from '../../design/components/Card';
import { VStack } from '../../design/components/Layout';
import { Text } from '../../design/components/Text';
import type { LinkDoneResponse } from '@manaclaude/shared';
import { BackendError, errorText, isSuperseded } from '../../data/backend/client';
import { refreshDataset } from '../../data/backend/sync';
import { getFinance } from '../../data/store';
import { linkReturnUrl, openLinkPage } from './browser';
import { linkApi } from './linkApi';
import { isRateLimited, outcomeUnknown } from './sophtronPoll';
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
 *
 * SnapTrade's complete has no replay: once a repair is saved, asking again on
 * the same linkId gets 404. So after an answer that did not arrive the app
 * reloads Accounts first, and only then offers to ask again. Every retry is a
 * tap; nothing is sent again by itself.
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
  // The same linkId may be asked again on your tap (Check again).
  const [retryId, setRetryId] = useState<string | null>(null);
  // Accounts must be reloaded before anything is asked again.
  const [mustReload, setMustReload] = useState<string | null>(null);

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
    setRetryId(null);
    setMustReload(null);
    let done: LinkDoneResponse;
    try {
      done = await linkApi.snaptradeComplete(id);
    } catch (e) {
      await completeFailed(e, id);
      return;
    }
    // A repair answers 200 with this connection and repaired true; anything
    // else is not taken as a repair.
    if (repair && !(done.repaired && done.connectionIds.includes(connectionId!))) {
      setLinkId(null);
      await afterReload(
        'Your Worker did not report this connection as repaired, so the repair is not confirmed.',
      );
      return;
    }
    onLinked(done.connectionIds, done.repaired);
  };

  /** Reloads Accounts, then says what it shows. True when the reload worked. */
  const afterReload = async (lead: string): Promise<boolean> => {
    const ok = await refreshDataset();
    if (!ok) {
      setError(
        `${lead} Accounts could not be reloaded, so the app can't tell what was saved. Reload before you try again.`,
      );
      return false;
    }
    setError(`${lead} Accounts has been reloaded.`);
    return true;
  };

  /** True when the reloaded data shows the connection being repaired as working again. */
  const repairShows = () => {
    const conn = getFinance().connections.find((c) => c.id === connectionId);
    return conn !== undefined && (conn.status === 'healthy' || conn.status === 'syncing');
  };

  /** After an answer that did not arrive: reload, then a repair already saved goes on to its sync. */
  const checkAfterLost = async (id: string) => {
    setMustReload(null);
    const lead = "The answer from your Worker didn't arrive, so nothing was sent again.";
    if (!(await afterReload(lead))) {
      setMustReload(id);
      return;
    }
    if (repair && repairShows()) {
      // The repair was saved before the answer was lost; the sync is the proof.
      onLinked([connectionId!], true);
      return;
    }
    setError(
      repair
        ? `${lead} Accounts has been reloaded and this connection still needs repair. Tap Check again to ask your Worker once more.`
        : `${lead} Accounts has been reloaded. Look there for the brokerage before you tap Check again, so it is not linked twice.`,
    );
    setRetryId(id);
  };

  const completeFailed = async (e: unknown, id: string) => {
    const code = e instanceof BackendError ? e.code : '';
    if (isSuperseded(e)) {
      setLinkId(null);
      setError(errorText(e));
    } else if (code === 'repair_not_finished') {
      setError(
        'SnapTrade has not finished the reconnect yet, so nothing was changed. Finish reconnecting your brokerage in SnapTrade (open it again if you closed it), then tap Check again.',
      );
      setRetryId(id);
    } else if (code === 'connection_changed') {
      setLinkId(null);
      const lead =
        'This connection changed on your Worker while it was being repaired, so this repair was not saved.';
      if (await afterReload(lead))
        setError(
          `${lead} Accounts has been reloaded: if the connection still needs repair, start a new repair.`,
        );
    } else if (e instanceof BackendError && e.status === 404) {
      // The attempt is over on the Worker: expired, failed, or already saved.
      setLinkId(null);
      const ok = await afterReload('This SnapTrade attempt has ended on your Worker.');
      if (ok && repair && repairShows()) onLinked([connectionId!], true);
      else if (ok)
        setError(
          repair
            ? 'This SnapTrade attempt has ended on your Worker, so nothing was changed. Accounts has been reloaded. Open SnapTrade again to repair the connection.'
            : 'This SnapTrade attempt has ended on your Worker. Accounts has been reloaded: look there for the brokerage before you open SnapTrade again.',
        );
    } else if (code === 'not_finished') {
      setError(
        `No new brokerage yet. Finish connecting in the SnapTrade window, then tap ${doneLabel}.`,
      );
    } else if (outcomeUnknown(e) && !(e instanceof BackendError && [502, 503].includes(e.status))) {
      // No answer, a timeout or a 500: the Worker may have saved it.
      await checkAfterLost(id);
    } else {
      setError(errorText(e));
      // SnapTrade itself failed or was busy: nothing was saved; asking again is safe.
      if (isRateLimited(e) || (e instanceof BackendError && e.status === 502)) setRetryId(id);
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

  const reloadByHand = async (id: string) => {
    setFinishing(true);
    try {
      await checkAfterLost(id);
    } finally {
      setFinishing(false);
    }
  };

  const open = async () => {
    setBusy(true);
    setError(null);
    setClosed(false);
    setRetryId(null);
    setMustReload(null);
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
  const offerDone =
    linkId !== null &&
    mustReload === null &&
    (retryId !== null || Platform.OS === 'web' || (closed && !isKite && !repair));

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
        {mustReload ? (
          <Button
            label="Reload Accounts"
            variant="secondary"
            loading={finishing}
            disabled={busy}
            onPress={() => void reloadByHand(mustReload)}
            testID="browser-reload"
          />
        ) : null}
        {offerDone && linkId ? (
          <Button
            label={retryId ? 'Check again' : doneLabel}
            variant="secondary"
            loading={finishing}
            disabled={busy}
            onPress={() => void finishByHand(retryId ?? linkId)}
            testID={retryId ? 'browser-retry' : 'browser-done'}
          />
        ) : null}
      </VStack>
    </Card>
  );
}
