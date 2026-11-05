/** Names the deploy creates or reuses in the Cloudflare account. Change them here only. */
export const WORKER_NAME = 'manaclaude-api';
export const D1_NAME = 'manaclaude';
export const R2_BUCKET = 'manaclaude-files';
/** KV namespace for the MCP OAuth grants. The second title is what `wrangler kv namespace create OAUTH_KV` would have made. */
export const KV_TITLES = ['manaclaude-oauth', 'manaclaude-api-OAUTH_KV'] as const;
export const PAGES_PROJECT = 'manaclaude';
export const CERT_NAME_PREFIX = 'manaclaude-teller-';

/** Placeholders in backend/wrangler.toml that the deploy swaps for real values. */
export const PLACEHOLDER_D1_ID = '00000000-0000-0000-0000-000000000000';
export const PLACEHOLDER_KV_ID = '00000000000000000000000000000000';
export const PLACEHOLDER_CERT_ID = '00000000-0000-0000-0000-00000000cert';

/**
 * GitHub secrets copied into Worker secrets (same name on both sides) when they
 * exist. Keep this list and the `env:` block of the "Copy secrets" step in
 * .github/workflows/deploy-worker.yml identical; deploy/test checks it.
 */
export const WORKER_SECRET_NAMES = [
  'APP_API_TOKEN',
  'MCP_OWNER_PASSWORD',
  'CREDENTIALS_SECRET',
  'OXR_APP_ID',
  'TELLER_APPLICATION_ID',
  'PLAID_CLIENT_ID',
  'PLAID_SECRET',
  'PLAID_ENV',
  'SNAPTRADE_CLIENT_ID',
  'SNAPTRADE_CONSUMER_KEY',
  'SOPHTRON_USER_ID',
  'SOPHTRON_ACCESS_KEY',
  'KITE_API_KEY',
  'KITE_API_SECRET',
  'ANTHROPIC_API_KEY',
] as const;
