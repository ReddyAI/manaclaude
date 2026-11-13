import { addDays } from '@manaclaude/shared';
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { createApp, type AppDeps } from './api/app';
import type { Env } from './env';
import { NIGHTLY_CRON, runNightlyStep } from './nightly';
import { fetchScheduledLatest } from './fx/latest';
import { backfillMissingHistory } from './fx/service';
import { handleAuthorize } from './mcp/authorize';
import { handleMcp } from './mcp/handler';
import type { McpAuthProps } from './mcp/tools';
import { syncDueConnections } from './sync/run';

/**
 * Connector syncs run on their own cron, a few connections per invocation, so
 * no invocation goes over the Free plan's D1 query limit (wrangler.toml lists it).
 */
export const SYNC_CRON = '*/5 * * * *';

/**
 * Worker entry point.
 * - /v1/*   the app's API (bearer APP_API_TOKEN), see api/app.ts
 * - /mcp    remote MCP server, Streamable HTTP, OAuth 2.1 (workers-oauth-provider)
 * - /authorize, /token, /register, /.well-known/*  OAuth endpoints
 * - cron    every 5 minutes: connector syncs (unfinished first syncs, then connections due
 *           today), within one invocation's D1 allowance; hourly FX and bounded history;
 *           daily ECB rates and bounded history; offset five-minute maintenance steps
 */
export function createWorker(deps: AppDeps = {}) {
  const app = createApp(deps);

  const defaultHandler = {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === '/authorize') return handleAuthorize(request, env);
      return app.fetch(request, env, ctx);
    },
  };

  const mcpHandler = {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const props = (ctx as ExecutionContext & { props?: McpAuthProps }).props ?? {
        userId: 'owner',
        scopes: ['read'],
      };
      return handleMcp(request, env, props);
    },
  };

  // The provider needs the public URL of /mcp (RFC 9728 resource), so it is
  // built on the first request and reused while PUBLIC_URL stays the same.
  let provider: OAuthProvider<Env> | null = null;
  let providerUrl = '';
  const getProvider = (env: Env): OAuthProvider<Env> => {
    const base = (env.PUBLIC_URL ?? 'http://localhost:8787').replace(/\/$/, '');
    if (provider && providerUrl === base) return provider;
    providerUrl = base;
    provider = new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler: mcpHandler as never,
      defaultHandler: defaultHandler as never,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/token',
      clientRegistrationEndpoint: '/register',
      scopesSupported: ['read', 'write'],
      accessTokenTTL: 3600,
      resourceMetadata: { resource: `${base}/mcp`, resource_name: 'Billionaire personal finance' },
    });
    return provider;
  };

  return {
    fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      return getProvider(env).fetch(request as never, env, ctx) as Promise<Response>;
    },

    async scheduled(
      controller: ScheduledController,
      env: Env,
      _ctx: ExecutionContext,
    ): Promise<void> {
      const f = deps.fetch ?? fetch;
      if (controller.cron === NIGHTLY_CRON) {
        await runNightlyStep(env, new Date(controller.scheduledTime), deps).catch((e) =>
          console.error('Nightly step failed', String(e)),
        );
        return;
      }
      if (controller.cron === SYNC_CRON) {
        await syncDueConnections(env, {
          fetch: deps.fetch,
          now: () => new Date(controller.scheduledTime),
        }).catch((e) => console.error('Connector syncs failed', String(e)));
        return;
      }
      const today = new Date(controller.scheduledTime).toISOString().slice(0, 10);
      const backfill = () =>
        backfillMissingHistory(env, f, {
          now: deps.now,
          through: addDays(today, -1),
        }).catch((e) => console.error('FX backfill failed', String(e)));
      if (controller.cron === '0 * * * *') {
        await fetchScheduledLatest(env, 'openexchangerates', f).catch((e) =>
          console.error('OXR fetch failed', String(e)),
        );
        await backfill();
        return;
      }
      await fetchScheduledLatest(env, 'frankfurter_ecb', f).catch((e) =>
        console.error('Frankfurter fetch failed', String(e)),
      );
      await backfill();
    },
  };
}
