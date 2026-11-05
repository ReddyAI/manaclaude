import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { createApp, type AppDeps } from './api/app';
import type { Env } from './env';
import { runDailyJobs } from './ai/jobs';
import { backfillMissingHistory, fetchFrankfurterLatest, fetchOpenExchangeRates } from './fx/service';
import { handleAuthorize } from './mcp/authorize';
import { handleMcp } from './mcp/handler';
import type { McpAuthProps } from './mcp/tools';
import { selectAll } from './db/table';
import { connectionsTable } from './db/tables';
import { runConnectionSync } from './sync/run';

export type { Env } from './env';

/**
 * Worker entry point.
 * - /v1/*   the app's API (bearer APP_API_TOKEN), see api/app.ts
 * - /mcp    remote MCP server, Streamable HTTP, OAuth 2.1 (workers-oauth-provider)
 * - /authorize, /token, /register, /.well-known/*  OAuth endpoints
 * - cron    hourly FX; daily ECB rates, backfill, connector syncs and AI jobs
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
      const props = (ctx as ExecutionContext & { props?: McpAuthProps }).props ?? { userId: 'owner', scopes: ['read'] };
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
      resourceMetadata: { resource: `${base}/mcp`, resource_name: 'Mana personal finance' },
    });
    return provider;
  };

  return {
    fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      return getProvider(env).fetch(request as never, env, ctx) as Promise<Response>;
    },

    async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
      const f = deps.fetch ?? fetch;
      if (controller.cron === '0 * * * *') {
        await fetchOpenExchangeRates(env, f).catch((e) => console.error('OXR fetch failed', String(e)));
        return;
      }
      const today = new Date(controller.scheduledTime).toISOString().slice(0, 10);
      await fetchFrankfurterLatest(env, f).catch((e) => console.error('Frankfurter fetch failed', String(e)));
      await backfillMissingHistory(env, f).catch((e) => console.error('FX backfill failed', String(e)));
      const connections = await selectAll(env.DB, connectionsTable, "status != 'disconnected'");
      for (const c of connections) {
        await runConnectionSync(env, c.id, f).catch((e) => console.error('Sync failed', c.connectorId, String(e)));
      }
      ctx.waitUntil(runDailyJobs(env, today, deps).then(() => undefined));
    },
  };
}

const worker = createWorker();

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => worker.fetch(request, env, ctx),
  scheduled: (controller: ScheduledController, env: Env, ctx: ExecutionContext) => worker.scheduled(controller, env, ctx),
} satisfies ExportedHandler<Env>;
