import type { Env } from '../env';
import { safeEqual } from '../util/ids';

const FAIL_LIMIT = 10;
const FAIL_WINDOW_SECONDS = 3600;

function escape(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function page(opts: {
  handle: string;
  clientName: string;
  redirectHost: string;
  scopes: string[];
  error?: string;
}): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to Billionaire</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--text:#14171c;--muted:#5b6370;--accent:#2457d6;--danger:#b42318;--line:#d9dde3}
@media (prefers-color-scheme:dark){:root{--bg:#000814;--card:#0b1424;--text:#e6e8eb;--muted:#9aa3b2;--accent:#6c9bff;--danger:#ff8a80;--line:#1f2b40}}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
main{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px;max-width:420px;width:100%}
h1{font-size:20px;margin:0 0 8px}p{margin:0 0 16px;color:var(--muted)}label{display:block;font-weight:600;margin-bottom:6px}
input[type=password]{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--text);font-size:16px}
.row{display:flex;gap:8px;margin-top:16px}button{flex:1;padding:10px;border-radius:8px;border:1px solid var(--line);font-size:16px;cursor:pointer;background:transparent;color:var(--text)}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}.error{color:var(--danger);margin-bottom:12px}
</style></head><body><main>
<h1>Connect ${escape(opts.clientName)} to Billionaire</h1>
<p>${escape(opts.clientName)} wants to read your accounts, transactions, budgets, investments and receipts. It will send you back to <strong>${escape(opts.redirectHost)}</strong>.${
    opts.scopes.includes('write')
      ? " Write tools stay off unless you turn them on in Billionaire's settings."
      : ''
  }</p>
${opts.error ? `<p class="error">${escape(opts.error)}</p>` : ''}
<form method="post">
<input type="hidden" name="handle" value="${escape(opts.handle)}">
<label for="password">Owner password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
<div class="row"><button type="submit" name="action" value="deny">Cancel</button><button class="primary" type="submit" name="action" value="approve">Allow</button></div>
</form></main></body></html>`;
}

function html(body: string, headers: Headers, status = 200): Response {
  const h = new Headers(headers);
  h.set('content-type', 'text/html; charset=utf-8');
  h.set('cache-control', 'no-store');
  return new Response(body, { status, headers: h });
}

const SUPPORTED_SCOPES = ['read', 'write'];

/**
 * The OAuth consent page for the MCP server. There is one user, so "signing
 * in" is the owner password (MCP_OWNER_PASSWORD secret). Failed attempts are
 * counted per IP in KV and blocked after 10 an hour.
 */
export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  if (!oauth || !env.OAUTH_KV) return new Response('OAuth is not configured.', { status: 500 });
  if (!env.MCP_OWNER_PASSWORD)
    return new Response('Set the MCP_OWNER_PASSWORD secret first.', { status: 503 });
  const authReq = await oauth.parseAuthRequest(request);
  const consent = await oauth.describeConsent(authReq);
  const scopes = authReq.scope.filter((s) => SUPPORTED_SCOPES.includes(s));
  const granted = scopes.length > 0 ? scopes : SUPPORTED_SCOPES;
  if (request.method === 'GET') {
    const { handle, headers } = await oauth.beginConsent(authReq);
    return html(
      page({
        handle,
        clientName: consent.clientName,
        redirectHost: consent.redirectHost,
        scopes: granted,
      }),
      headers,
    );
  }
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const form = await request.formData();
  const handle = String(form.get('handle') ?? '');
  if (form.get('action') === 'deny') {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const ip = request.headers.get('cf-connecting-ip') ?? 'local';
  const failKey = `authfail:${ip}`;
  const fails = Number((await env.OAUTH_KV.get(failKey)) ?? '0');
  if (fails >= FAIL_LIMIT)
    return new Response('Too many wrong passwords. Try again in an hour.', { status: 429 });
  if (!safeEqual(String(form.get('password') ?? ''), env.MCP_OWNER_PASSWORD)) {
    await env.OAUTH_KV.put(failKey, String(fails + 1), { expirationTtl: FAIL_WINDOW_SECONDS });
    // The handle is still valid (not consumed), so the same form can be retried.
    return html(
      page({
        handle,
        clientName: consent.clientName,
        redirectHost: consent.redirectHost,
        scopes: granted,
        error: 'Wrong password.',
      }),
      new Headers(),
      401,
    );
  }
  const approved = await oauth.approveConsent(request, handle, { scope: granted });
  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request,
    userId: 'owner',
    metadata: { label: consent.clientName },
    scope: granted,
    props: { userId: 'owner', scopes: granted },
  });
  const headers = new Headers(approved.headers);
  headers.set('location', redirectTo);
  return new Response(null, { status: 302, headers });
}
