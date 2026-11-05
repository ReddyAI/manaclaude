import { beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { addAccount, addTxn, allTxns, db, freshDb } from './helpers';
import { updateSettings } from '../src/services/settings';
import { BASE, client } from './worker';

beforeEach(freshDb);

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Walks the same OAuth flow Claude and Perplexity use: DCR, consent page, PKCE token exchange. */
async function getAccessToken(raw: ReturnType<typeof client>['raw'], scope = 'read write') {
  const meta = await raw('/.well-known/oauth-authorization-server');
  expect(meta.status).toBe(200);
  const as = (await meta.json()) as {
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint: string;
  };
  const prm = await raw('/.well-known/oauth-protected-resource/mcp');
  expect(prm.status).toBe(200);
  expect(((await prm.json()) as { resource: string }).resource).toBe(`${BASE}/mcp`);

  const reg = await raw(as.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Test Assistant',
      redirect_uris: ['https://assistant.example/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  expect(reg.status).toBe(201);
  const { client_id } = (await reg.json()) as { client_id: string };

  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
  );
  const params = new URLSearchParams({
    response_type: 'code',
    client_id,
    redirect_uri: 'https://assistant.example/callback',
    scope,
    state: 'xyz',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${BASE}/mcp`,
  });
  const authUrl = `${as.authorization_endpoint}?${params}`;
  const page = await raw(authUrl);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('Connect Test Assistant to Mana');
  const handle = html.match(/name="handle" value="([^"]+)"/)![1]!;
  const cookie = (page.headers.get('set-cookie') ?? '').split(';')[0]!;

  const submit = (password: string) =>
    raw(authUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ handle, password, action: 'approve' }).toString(),
      redirect: 'manual',
    });
  const wrong = await submit('nope');
  expect(wrong.status).toBe(401);
  const ok = await submit('test-owner-password');
  expect(ok.status).toBe(302);
  const location = new URL(ok.headers.get('location')!);
  expect(location.origin + location.pathname).toBe('https://assistant.example/callback');
  expect(location.searchParams.get('state')).toBe('xyz');
  const code = location.searchParams.get('code')!;

  const tok = await raw(as.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'https://assistant.example/callback',
      client_id,
      code_verifier: verifier,
      resource: `${BASE}/mcp`,
    }).toString(),
  });
  expect(tok.status).toBe(200);
  return ((await tok.json()) as { access_token: string }).access_token;
}

async function connect(raw: ReturnType<typeof client>['raw'], token: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: (url, init) => raw(String(url), init as RequestInit),
  });
  const mcp = new Client({ name: 'test-client', version: '1.0.0' });
  await mcp.connect(transport);
  return mcp;
}

function json(res: unknown): Record<string, unknown> {
  const content = (res as { content: { type: string; text: string }[] }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

describe('MCP server at /mcp', () => {
  it('rejects requests without a token and advertises where to get one', async () => {
    const { raw } = client();
    const res = await raw('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata');
  });

  it('lists read tools only while write tools are off (the default)', async () => {
    const { raw } = client();
    const token = await getAccessToken(raw);
    const mcp = await connect(raw, token);
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'budget_status',
        'holdings_with_lots',
        'list_accounts',
        'list_recurring',
        'net_worth_history',
        'search_receipts',
        'search_transactions',
        'spending_summary',
      ].sort(),
    );
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    await mcp.close();
  });

  it('answers read tools from D1 with the money policies applied', async () => {
    const checking = await addAccount({
      type: 'checking',
      name: 'Everyday Checking',
      balance: 250_000,
    });
    const card = await addAccount({ type: 'credit_card', name: 'Rewards Card', balance: 20_000 });
    await addTxn(card, {
      date: '2026-10-03',
      amount: -20_000,
      rawName: 'OUTFITTERS',
      categoryId: 'cat_shopping',
    });
    await addTxn(checking, { date: '2026-10-25', amount: -20_000, rawName: 'CARD PAYMENT' });
    await addTxn(card, { date: '2026-10-25', amount: 20_000, rawName: 'PAYMENT - THANK YOU' });
    await client().api('POST', '/v1/transfer-links/run');
    const { raw } = client();
    const mcp = await connect(raw, await getAccessToken(raw));
    const accounts = json(await mcp.callTool({ name: 'list_accounts', arguments: {} }));
    expect((accounts.accounts as { name: string }[]).map((a) => a.name)).toEqual([
      'Everyday Checking',
      'Rewards Card',
    ]);
    const summary = json(
      await mcp.callTool({
        name: 'spending_summary',
        arguments: { from: '2026-10-01', to: '2026-10-31', currency: 'USD' },
      }),
    );
    expect(summary.spending).toEqual({ minor: 20_000, currency: 'USD', formatted: '$200.00' });
    const search = json(
      await mcp.callTool({ name: 'search_transactions', arguments: { query: 'payment' } }),
    );
    expect(
      (search.transactions as { linkedTransfer: boolean }[]).every((t) => t.linkedTransfer),
    ).toBe(true);
    await mcp.close();
  });

  it('exposes write tools only after they are turned on, and they change data', async () => {
    const checking = await addAccount({ type: 'checking' });
    const t = await addTxn(checking, { date: '2026-11-01', amount: -4_500, rawName: 'GREENLEAF' });
    await updateSettings(db, { mcpWriteToolsEnabled: true });
    const { raw } = client();
    const mcp = await connect(raw, await getAccessToken(raw));
    const names = (await mcp.listTools()).tools.map((x) => x.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'categorize_transaction',
        'add_cash_transaction',
        'tag_transaction',
        'link_transfer',
      ]),
    );
    await mcp.callTool({
      name: 'categorize_transaction',
      arguments: { transactionId: t.id, categoryId: 'cat_gifts' },
    });
    await mcp.callTool({ name: 'tag_transaction', arguments: { transactionId: t.id, tag: 'Tax' } });
    const cash = json(
      await mcp.callTool({
        name: 'add_cash_transaction',
        arguments: { amount: -800, currency: 'USD', name: 'Parking' },
      }),
    );
    expect(cash.amount).toMatchObject({ minor: -800 });
    const txns = await allTxns();
    expect(txns.find((x) => x.id === t.id)).toMatchObject({
      categoryId: 'cat_gifts',
      tagIds: ['tag_tax'],
    });
    expect(txns.find((x) => x.id === t.id)?.userEditedFields).toEqual(
      expect.arrayContaining(['categoryId', 'tagIds']),
    );
    await mcp.close();
  });

  it('a read-only grant never sees write tools, even with the setting on', async () => {
    await updateSettings(db, { mcpWriteToolsEnabled: true });
    const { raw } = client();
    const mcp = await connect(raw, await getAccessToken(raw, 'read'));
    const names = (await mcp.listTools()).tools.map((x) => x.name);
    expect(names).not.toContain('categorize_transaction');
    await mcp.close();
  });

  it('can create a confidential client for assistants that need a client ID and secret', async () => {
    const res = await client().api<{ clientId: string; clientSecret: string }>(
      'POST',
      '/v1/mcp/clients',
      {
        name: 'Perplexity',
        redirectUris: ['https://assistant.example/callback'],
      },
    );
    expect(res.status).toBe(201);
    expect(res.body.clientId).toBeTruthy();
    expect(res.body.clientSecret).toBeTruthy();
    expect(
      (await client().api('POST', '/v1/mcp/clients', { name: 'x', redirectUris: [] })).status,
    ).toBe(400);
  });
});
