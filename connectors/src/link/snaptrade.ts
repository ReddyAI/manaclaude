import type { ConnectorContext } from '@manaclaude/shared';
import { HttpClient, type Query } from '../http';
import { appSecret } from '../kit';
import { ProviderDataError } from '../errors';
import { SNAPTRADE_API, snaptradeSignature } from '../adapters/snaptrade';

/**
 * SnapTrade Personal linking with the key-and-signature API (the same signing
 * the adapter uses): register one SnapTrade user for the app, open the
 * connection portal for it, and after the person connects a brokerage, list
 * the user's authorizations (one per brokerage login, one free slot each).
 * A broken login is repaired by opening the portal with `reconnect` set to the
 * same authorization id.
 */

export interface SnaptradeUser {
  userId: string;
  userSecret: string;
}

export interface SnaptradeAuthorization {
  id: string;
  name: string;
  disabled: boolean;
}

function client(ctx: ConnectorContext): HttpClient {
  const consumerKey = appSecret(ctx, 'SNAPTRADE_CONSUMER_KEY', 'SnapTrade');
  return new HttpClient(ctx, {
    provider: 'SnapTrade',
    baseUrl: SNAPTRADE_API,
    repairStatuses: [],
    retries: 1,
    sign: async ({ path, query, body }) => ({
      Signature: await snaptradeSignature(consumerKey, path, query, body),
    }),
  });
}

/** clientId and timestamp (and the user, when given), keys sorted so the signed string is the sent one. */
function signedQuery(ctx: ConnectorContext, user?: SnaptradeUser): Query {
  const params: Record<string, string | number> = {
    clientId: appSecret(ctx, 'SNAPTRADE_CLIENT_ID', 'SnapTrade'),
    timestamp: Math.floor(ctx.now().getTime() / 1000),
  };
  if (user) {
    params.userId = user.userId;
    params.userSecret = user.userSecret;
  }
  return Object.fromEntries(Object.entries(params).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export async function registerSnaptradeUser(
  ctx: ConnectorContext,
  userId: string,
): Promise<SnaptradeUser> {
  const resp = await client(ctx).post<{ userId?: string; userSecret?: string }>(
    '/api/v1/snapTrade/registerUser',
    { userId },
    { query: signedQuery(ctx) },
  );
  if (!resp?.userId || !resp.userSecret) throw new ProviderDataError('SnapTrade', 'register user');
  return { userId: resp.userId, userSecret: resp.userSecret };
}

export async function snaptradePortalUrl(
  ctx: ConnectorContext,
  user: SnaptradeUser,
  opts: { customRedirect: string; reconnect?: string },
): Promise<string> {
  const body: Record<string, unknown> = {
    connectionType: 'read',
    customRedirect: opts.customRedirect,
    immediateRedirect: true,
  };
  if (opts.reconnect) body.reconnect = opts.reconnect;
  const resp = await client(ctx).post<{ redirectURI?: string; redirectUri?: string }>(
    '/api/v1/snapTrade/login',
    body,
    { query: signedQuery(ctx, user) },
  );
  const url = resp?.redirectURI ?? resp?.redirectUri;
  if (!url || !/^https:\/\//.test(url)) throw new ProviderDataError('SnapTrade', 'portal link');
  return url;
}

export async function listSnaptradeAuthorizations(
  ctx: ConnectorContext,
  user: SnaptradeUser,
): Promise<SnaptradeAuthorization[]> {
  const resp = await client(ctx).get<unknown>('/api/v1/authorizations', signedQuery(ctx, user));
  if (!Array.isArray(resp)) throw new ProviderDataError('SnapTrade', 'authorizations');
  return (resp as Record<string, unknown>[])
    .filter((a) => typeof a.id === 'string')
    .map((a) => {
      const brokerage = (a.brokerage ?? {}) as { name?: unknown; display_name?: unknown };
      const name =
        (typeof brokerage.display_name === 'string' && brokerage.display_name) ||
        (typeof brokerage.name === 'string' && brokerage.name) ||
        (typeof a.name === 'string' && a.name) ||
        'Brokerage';
      return { id: a.id as string, name, disabled: a.disabled === true };
    });
}
