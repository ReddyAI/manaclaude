import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Env } from '../env';
import { buildMcpServer, type McpAuthProps } from './tools';

/**
 * Stateless Streamable HTTP MCP endpoint (POST /mcp). Each request builds a
 * fresh server, so no Durable Objects are needed on the free plan. The OAuth
 * provider has already checked the access token and put the grant's props on
 * ctx.props.
 */
export async function handleMcp(
  request: Request,
  env: Env,
  props: McpAuthProps,
): Promise<Response> {
  if (request.method === 'GET') {
    // No server-initiated stream in stateless mode.
    return new Response(null, { status: 405, headers: { allow: 'POST' } });
  }
  const server = await buildMcpServer(env, props);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    void server.close();
  }
}
