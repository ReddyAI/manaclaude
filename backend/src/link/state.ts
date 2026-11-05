import type { Env } from '../env';

/**
 * Signed, expiring `state` for browser redirects (Zerodha Kite, SnapTrade).
 * The provider sends the browser back to a public callback with no bearer
 * token, so the callback trusts nothing but this value: the link session id
 * and an expiry time, signed with HMAC-SHA256 under a key derived from the
 * CREDENTIALS_SECRET Worker secret (HKDF, its own label, so it is not the
 * encryption key). The session itself is single-use in D1.
 */

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function stateKey(env: Env): Promise<CryptoKey> {
  const secret = env.CREDENTIALS_SECRET;
  if (!secret) throw new Error('CREDENTIALS_SECRET is not set.');
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: enc.encode('mana-link-state-v1'),
      info: new Uint8Array(),
    },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );
}

export async function signState(env: Env, linkId: string, expiresAt: Date): Promise<string> {
  const payload = `${linkId}.${Math.floor(expiresAt.getTime() / 1000)}`;
  const sig = await crypto.subtle.sign('HMAC', await stateKey(env), enc.encode(payload));
  return `${payload}.${b64url(new Uint8Array(sig))}`;
}

/** The link session id inside a valid, unexpired state; null otherwise. */
export async function verifyState(
  env: Env,
  state: string | undefined | null,
  now: Date,
): Promise<string | null> {
  if (!state || !env.CREDENTIALS_SECRET) return null;
  const parts = state.split('.');
  if (parts.length !== 3) return null;
  const [linkId, exp, sig] = parts as [string, string, string];
  if (!/^link_[a-f0-9]{32}$/.test(linkId) || !/^\d{9,11}$/.test(exp)) return null;
  const bytes = fromB64url(sig);
  if (!bytes) return null;
  const ok = await crypto.subtle.verify(
    'HMAC',
    await stateKey(env),
    bytes,
    enc.encode(`${linkId}.${exp}`),
  );
  if (!ok) return null;
  if (Number(exp) * 1000 < now.getTime()) return null;
  return linkId;
}

/**
 * Where a callback may send the browser afterwards: the app's own scheme
 * (billionaire://), the web app on Cloudflare Pages, an origin listed in
 * APP_ORIGIN, or localhost for development. Anything else is dropped, so a
 * callback can never be used to redirect somewhere else.
 */
export function safeReturnUrl(env: Env, raw: string | undefined | null): string | null {
  if (!raw || raw.length > 500) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol === 'billionaire:') return url.toString();
  const host = url.hostname.toLowerCase();
  if (url.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1'))
    return url.toString();
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  if (host === 'manaclaude.pages.dev' || host.endsWith('.manaclaude.pages.dev'))
    return url.toString();
  const origins = (env.APP_ORIGIN ?? '*')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o && o !== '*');
  return origins.includes(url.origin) ? url.toString() : null;
}

export function withParams(url: string, params: Record<string, string>): string {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}
