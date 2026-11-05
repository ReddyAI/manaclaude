import type { ConnectorContext } from '@manaclaude/shared';
import { HttpClient } from '../http';
import { appSecret, optionalSecret } from '../kit';
import { ProviderDataError } from '../errors';

/**
 * Plaid Link: a link token for the Link UI (react-native-plaid-link-sdk on
 * Android, Plaid's web Link on the web), then the public token Link hands back
 * is exchanged for the access token the adapter syncs with. Update mode (the
 * repair flow) passes the existing access token instead, so Plaid reuses the
 * same Item and no lifetime login is spent.
 *
 * Only tested against invented responses: the owner asked that nothing calls
 * Plaid, not even its Sandbox, until they say so (the backend also keeps
 * PLAID_LINK_ENABLED off).
 */

const HOSTS = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
} as const;

function client(ctx: ConnectorContext): HttpClient {
  const env = optionalSecret(ctx, 'PLAID_ENV') === 'sandbox' ? 'sandbox' : 'production';
  return new HttpClient(ctx, {
    provider: 'Plaid',
    baseUrl: HOSTS[env],
    headers: {
      'PLAID-CLIENT-ID': appSecret(ctx, 'PLAID_CLIENT_ID', 'Plaid'),
      'PLAID-SECRET': appSecret(ctx, 'PLAID_SECRET', 'Plaid'),
    },
    repairStatuses: [],
    retries: 1,
  });
}

export interface PlaidLinkTokenOptions {
  /** A stable id for the one person using the app (never personal data). */
  clientUserId: string;
  platform: 'android' | 'ios' | 'web';
  /** Android package name registered in Plaid's dashboard (needed by the Android SDK). */
  androidPackageName?: string;
  /** OAuth redirect URI registered in Plaid's dashboard (web and iOS OAuth banks). */
  redirectUri?: string;
  /** Update mode: the access token of the login being repaired. */
  accessToken?: string;
}

export async function createPlaidLinkToken(
  ctx: ConnectorContext,
  opts: PlaidLinkTokenOptions,
): Promise<{ linkToken: string; expiration: string | null }> {
  const body: Record<string, unknown> = {
    client_name: 'Billionaire',
    language: 'en',
    country_codes: ['US'],
    user: { client_user_id: opts.clientUserId },
  };
  if (opts.accessToken) {
    body.access_token = opts.accessToken;
  } else {
    body.products = ['transactions'];
    body.optional_products = ['investments', 'liabilities'];
    body.transactions = { days_requested: 730 };
  }
  if (opts.platform === 'android' && opts.androidPackageName) {
    body.android_package_name = opts.androidPackageName;
  } else if (opts.redirectUri) {
    body.redirect_uri = opts.redirectUri;
  }
  const resp = await client(ctx).post<{ link_token?: string; expiration?: string }>(
    '/link/token/create',
    body,
  );
  if (!resp?.link_token) throw new ProviderDataError('Plaid', 'link token');
  return { linkToken: resp.link_token, expiration: resp.expiration ?? null };
}

export async function exchangePlaidPublicToken(
  ctx: ConnectorContext,
  publicToken: string,
): Promise<{ accessToken: string; itemId: string }> {
  const resp = await client(ctx).post<{ access_token?: string; item_id?: string }>(
    '/item/public_token/exchange',
    { public_token: publicToken },
  );
  if (!resp?.access_token || !resp.item_id) throw new ProviderDataError('Plaid', 'token exchange');
  return { accessToken: resp.access_token, itemId: resp.item_id };
}
