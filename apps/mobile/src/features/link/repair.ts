import { planRepair } from '@manaclaude/connectors/health';
import { getConnector } from '@manaclaude/connectors/registry';
import type { Connection } from '@manaclaude/shared';
import { router } from 'expo-router';
import { Platform } from 'react-native';
import { errorText } from '../../data/backend/client';
import { isBackendReady } from '../../data/backend/config';
import { refreshDataset } from '../../data/backend/sync';
import { linkReturnUrl, openLinkPage } from './browser';
import { linkApi, syncUntilDone } from './linkApi';

/**
 * The Repair button (session D's planRepair decides how). A broken login is
 * always repaired on the same connection: same accounts, same history, no new
 * slot. Zerodha is one tap: the Kite login opens straight away, because its
 * login ends every morning by design.
 *
 * Returns a sentence to show, or null when the repair moved to its own screen.
 */
export async function startRepair(connection: Connection): Promise<string | null> {
  if (!isBackendReady()) return 'Set up the backend in Settings first.';
  const def = getConnector(connection.connectorId);
  if (!def) return 'This connector is not known to the app.';
  const plan = planRepair(connection, def);
  if (plan.method === 'none') return plan.instructions;
  if (connection.connectorId === 'zerodha_kite') {
    try {
      const { url } = await linkApi.kiteStart(connection.id, linkReturnUrl());
      const back = await openLinkPage(url);
      if (Platform.OS === 'web') return 'Log in to Zerodha in the new tab, then tap Sync now.';
      if (back.result === 'error') return back.message ?? 'Zerodha did not finish the login.';
      if (back.result !== 'ok') return null;
      await syncUntilDone(connection.id, () => {}, { force: true });
      await refreshDataset();
      return 'Zerodha is connected again.';
    } catch (e) {
      return errorText(e);
    }
  }
  router.push({
    pathname: '/link/[connector]',
    params: { connector: connection.connectorId, connectionId: connection.id },
  });
  return null;
}
