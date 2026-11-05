import type { Env } from '../env';

/**
 * The Worker-level secrets each adapter reads from ctx.secrets, by connector id
 * (connectors/README.md, "Secrets each adapter reads"). A connector only sees
 * its own names. Per-login values come from the encrypted credentials table.
 */
export const WORKER_SECRETS_BY_CONNECTOR: Readonly<Record<string, readonly string[]>> = {
  sophtron: ['SOPHTRON_USER_ID', 'SOPHTRON_ACCESS_KEY'],
  plaid: ['PLAID_CLIENT_ID', 'PLAID_SECRET', 'PLAID_ENV'],
  snaptrade: ['SNAPTRADE_CLIENT_ID', 'SNAPTRADE_CONSUMER_KEY'],
  zerodha_kite: ['KITE_API_KEY', 'KITE_API_SECRET'],
  enable_banking: ['ENABLEBANKING_APPLICATION_ID', 'ENABLEBANKING_PRIVATE_KEY'],
  akahu: ['AKAHU_APP_TOKEN'],
  rentcast: ['RENTCAST_API_KEY'],
  realie: ['REALIE_API_KEY'],
  twelve_data: ['TWELVEDATA_API_KEY'],
  tiingo: ['TIINGO_API_TOKEN'],
  eodhd: ['EODHD_API_KEY'],
};

/** Property value providers charge per call, so they refresh at most this often. */
export const VALUATION_CONNECTORS: readonly string[] = ['rentcast', 'realie'];

export function workerSecretsFor(env: Env, connectorId: string): Record<string, string> {
  const out: Record<string, string> = {};
  const bag = env as unknown as Record<string, unknown>;
  for (const name of WORKER_SECRETS_BY_CONNECTOR[connectorId] ?? []) {
    const value = bag[name];
    if (typeof value === 'string' && value !== '') out[name] = value;
  }
  return out;
}
