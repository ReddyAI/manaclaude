import type { Context, Hono } from 'hono';
import type { Env } from '../env';

/**
 * Account-linking callbacks. Providers send the user's browser back to the
 * Worker, which carries no bearer token, so these paths are public and each
 * handler must prove the request itself (a signed, expiring `state` value that
 * the app created when linking started). Everything else under /v1 needs the
 * bearer token.
 *
 * Session E2 (account linking) builds the handlers. Session E1 only reserves
 * the paths and the public-path rule, so the redirect URL can be registered
 * with the provider now:
 *
 *   Zerodha Kite Connect:  https://manaclaude-api.<subdomain>.workers.dev/v1/link/zerodha_kite/callback
 *   (Kite adds ?request_token=...&status=success&action=login to it.)
 */
export const LINK_CALLBACK_PATTERN = /^\/v1\/link\/[a-z0-9_]+\/callback$/;

/** The callbacks reserved so far. E2 adds to this list as it builds more. */
export const RESERVED_LINK_CALLBACKS = ['/v1/link/zerodha_kite/callback'] as const;

export function isPublicLinkCallback(path: string): boolean {
  return LINK_CALLBACK_PATTERN.test(path);
}

type AppEnv = { Bindings: Env };

/** Placeholder until session E2 replaces it: answers plainly instead of looking like a broken link. */
function notBuiltYet(c: Context<AppEnv>): Response {
  return c.json(
    {
      error: 'not_implemented',
      message: 'This account-linking callback is reserved but not built yet.',
    },
    501,
  );
}

export function registerLinkRoutes<E extends AppEnv>(app: Hono<E>): void {
  for (const path of RESERVED_LINK_CALLBACKS) {
    app.get(path, (c) => notBuiltYet(c as unknown as Context<AppEnv>));
  }
}
