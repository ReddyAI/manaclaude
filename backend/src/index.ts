import { DEFAULT_MONEY_POLICIES } from '@manaclaude/shared';
import type { Env } from './env';

/**
 * Worker entry point (session B builds the real API, imports, matching, FX,
 * AI provider layer and the MCP server at /mcp).
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function handleRequest(request: Request, _env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/health') {
    return json({ ok: true, service: 'manaclaude-api', policies: DEFAULT_MONEY_POLICIES });
  }
  return json({ error: 'not_found' }, 404);
}

export default {
  fetch: (request: Request, env: Env) => handleRequest(request, env),
  async scheduled(_controller: ScheduledController, _env: Env): Promise<void> {
    // Session B: hourly FX fetch, daily ECB backfill, connector syncs.
  },
} satisfies ExportedHandler<Env>;
