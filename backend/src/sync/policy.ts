import type { Env } from '../env';

/** One gate for linking, manual sync, cron and the outbound transport. Force never overrides it. */
export function connectorEnabled(env: Env, connectorId: string): boolean {
  return connectorId !== 'plaid' || env.PLAID_LINK_ENABLED === 'true';
}

export const PLAID_DISABLED_MESSAGE = 'Plaid is disabled. No data was requested.';
