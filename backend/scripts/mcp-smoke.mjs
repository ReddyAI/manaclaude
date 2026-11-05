// Live check of the MCP server: walks the OAuth flow that Claude and
// Perplexity use (client registration, consent page with the owner password,
// PKCE token exchange), then lists the tools and calls list_accounts.
//
//   node scripts/mcp-smoke.mjs http://localhost:8787 <MCP_OWNER_PASSWORD>
//   node scripts/mcp-smoke.mjs https://manaclaude-api.<you>.workers.dev <password>
/* eslint-disable no-console -- a command-line script */
/* global Buffer */
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [base = 'http://localhost:8787', password] = process.argv.slice(2);
if (!password) {
  console.error('Usage: node scripts/mcp-smoke.mjs <base-url> <owner-password>');
  process.exit(1);
}
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const redirect = 'http://localhost:9/callback';

const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
const reg = await (
  await fetch(as.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Mana smoke test',
      redirect_uris: [redirect],
      token_endpoint_auth_method: 'none',
    }),
  })
).json();
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash('sha256').update(verifier).digest());
const q = new URLSearchParams({
  response_type: 'code',
  client_id: reg.client_id,
  redirect_uri: redirect,
  scope: 'read write',
  state: 's',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  resource: `${base}/mcp`,
});
const authUrl = `${as.authorization_endpoint}?${q}`;
const page = await fetch(authUrl);
const html = await page.text();
const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
const cookie = (page.headers.get('set-cookie') ?? '').split(';')[0];
const approve = await fetch(authUrl, {
  method: 'POST',
  redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
  body: new URLSearchParams({ handle, password, action: 'approve' }),
});
if (approve.status !== 302) throw new Error(`Consent failed: HTTP ${approve.status}`);
const code = new URL(approve.headers.get('location')).searchParams.get('code');
const token = await (
  await fetch(as.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirect,
      client_id: reg.client_id,
      code_verifier: verifier,
      resource: `${base}/mcp`,
    }),
  })
).json();

const client = new Client({ name: 'mana-smoke', version: '1.0.0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token.access_token}` } },
  }),
);
const { tools } = await client.listTools();
console.log('Tools:', tools.map((t) => t.name).join(', '));
const res = await client.callTool({ name: 'list_accounts', arguments: {} });
const accounts = JSON.parse(res.content[0].text).accounts;
console.log(`list_accounts: ${accounts.length} accounts, first: ${accounts[0]?.name ?? 'none'}`);
await client.close();
