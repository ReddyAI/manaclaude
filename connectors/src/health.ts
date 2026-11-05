import type {
  Connection,
  ConnectionStatus,
  ConnectorDefinition,
  IsoDateTime,
} from '@manaclaude/shared';
import { ConnectorRepairNeededError } from '@manaclaude/shared';
import { ConnectorRateLimitedError } from './errors';

/**
 * Connection health and the repair flow.
 *
 * A broken login (expired token, changed password, MFA) is repaired, never
 * deleted and re-added: Teller and Plaid Trial count every login for life.
 * Repair keeps the connection id, its accounts and its sync cursor, so history
 * stays attached and no slot is spent.
 */

export type HealthTone = 'good' | 'warn' | 'bad' | 'idle';

export interface HealthView {
  status: ConnectionStatus;
  label: string;
  tone: HealthTone;
  /** Healthy but the last good sync is older than the stale limit. */
  stale: boolean;
  needsRepair: boolean;
  /** Short text for the UI: "Synced 3 h ago", "Repair needed". */
  detail: string;
}

export const STALE_AFTER_HOURS = 36;

function ago(from: IsoDateTime, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(from)) / 60_000));
  if (minutes < 2) return 'just now';
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export function describeHealth(
  c: Pick<Connection, 'status' | 'lastSyncAt' | 'lastSuccessfulSyncAt' | 'lastError'>,
  now: Date,
  staleAfterHours = STALE_AFTER_HOURS,
): HealthView {
  const last = c.lastSuccessfulSyncAt;
  const lastText = last ? `Synced ${ago(last, now)}` : 'Never synced';
  switch (c.status) {
    case 'needs_repair':
      return {
        status: c.status,
        label: 'Repair needed',
        tone: 'bad',
        stale: false,
        needsRepair: true,
        detail: c.lastError ?? 'Sign in again to keep syncing',
      };
    case 'error':
      return {
        status: c.status,
        label: 'Sync error',
        tone: 'warn',
        stale: false,
        needsRepair: false,
        detail: c.lastError ?? lastText,
      };
    case 'disconnected':
      return {
        status: c.status,
        label: 'Disconnected',
        tone: 'idle',
        stale: false,
        needsRepair: false,
        detail: last ? lastText : 'Not connected',
      };
    case 'syncing':
      return {
        status: c.status,
        label: 'Syncing',
        tone: 'idle',
        stale: false,
        needsRepair: false,
        detail: lastText,
      };
    default: {
      const stale = !last || now.getTime() - Date.parse(last) > staleAfterHours * 3_600_000;
      return {
        status: c.status,
        label: stale ? 'Stale' : 'Healthy',
        tone: stale ? 'warn' : 'good',
        stale,
        needsRepair: false,
        detail: lastText,
      };
    }
  }
}

/** Connection after a sync that worked. */
export function afterSyncSuccess(
  c: Connection,
  now: IsoDateTime,
  nextCursor: string | null,
  accountIds?: string[],
): Connection {
  return {
    ...c,
    status: 'healthy',
    lastSyncAt: now,
    lastSuccessfulSyncAt: now,
    lastError: null,
    syncCursor: nextCursor ?? c.syncCursor,
    accountIds: accountIds ?? c.accountIds,
    updatedAt: now,
  };
}

/** Connection after a sync that threw. Auth failures need repair; other failures just record the error. */
export function afterSyncFailure(c: Connection, error: unknown, now: IsoDateTime): Connection {
  const message = error instanceof Error ? error.message : 'Sync failed';
  if (error instanceof ConnectorRepairNeededError) {
    return { ...c, status: 'needs_repair', lastSyncAt: now, lastError: message, updatedAt: now };
  }
  if (error instanceof ConnectorRateLimitedError) {
    // Temporary. Keep a healthy badge healthy; the next scheduled sync tries again.
    const status: ConnectionStatus =
      c.status === 'needs_repair' ? 'needs_repair' : c.status === 'healthy' ? 'healthy' : 'error';
    return { ...c, status, lastSyncAt: now, lastError: message, updatedAt: now };
  }
  return {
    ...c,
    status: c.status === 'needs_repair' ? 'needs_repair' : 'error',
    lastSyncAt: now,
    lastError: message,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Repair flow
// ---------------------------------------------------------------------------

export type RepairMethod =
  'relink_widget' | 'reauthorize' | 'new_token' | 'reenter_credentials' | 'none';

export interface RepairPlan {
  connectionId: string;
  connectorId: string;
  method: RepairMethod;
  /** Repair never uses a new slot. */
  usesNewSlot: false;
  /** What stays attached while the login is renewed. */
  keeps: { accountIds: string[]; syncCursor: string | null };
  /** One sentence for the Repair sheet. */
  instructions: string;
}

const METHOD_BY_AUTH: Record<ConnectorDefinition['auth'], RepairMethod> = {
  link_widget: 'relink_widget',
  oauth: 'reauthorize',
  personal_token: 'new_token',
  api_key: 'new_token',
  credentials: 'reenter_credentials',
  public_address: 'none',
  none: 'none',
};

const INSTRUCTIONS: Record<RepairMethod, string> = {
  relink_widget:
    'Open the bank sign-in window again for this same login. Your accounts and history stay as they are.',
  reauthorize:
    'Approve access again with the provider. Your accounts and history stay as they are.',
  new_token:
    'Paste a fresh token or key from the provider. Your accounts and history stay as they are.',
  reenter_credentials:
    'Enter the sign-in details again (and answer any security question). Your accounts and history stay as they are.',
  none: 'Nothing to repair: this connector needs no login.',
};

export function planRepair(connection: Connection, def: ConnectorDefinition): RepairPlan {
  const method = METHOD_BY_AUTH[def.auth];
  return {
    connectionId: connection.id,
    connectorId: connection.connectorId,
    method,
    usesNewSlot: false,
    keeps: { accountIds: [...connection.accountIds], syncCursor: connection.syncCursor },
    instructions: INSTRUCTIONS[method],
  };
}

/** The user finished the repair step: clear the error and queue a sync. The next success makes it healthy. */
export function completeRepair(connection: Connection, now: IsoDateTime): Connection {
  return { ...connection, status: 'syncing', lastError: null, updatedAt: now };
}
