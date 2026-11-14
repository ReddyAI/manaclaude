import { ConnectorConfigError } from '@manaclaude/connectors';
import type { Env } from '../env';
import { nowIso } from '../util/ids';

/**
 * Encrypted per-login credentials (a Teller access token, a Kite access token,
 * a Questrade refresh token...). One row per connection, holding a JSON object
 * of secret name -> value, encrypted with AES-GCM. The key comes from the
 * Worker secret CREDENTIALS_SECRET (HKDF-SHA256), so the database on its own is
 * useless. Account linking (session E2) writes with saveCredentials; sync reads
 * with loadCredentials and saves rotated tokens with the same function.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function keyFor(env: Env): Promise<CryptoKey> {
  const secret = env.CREDENTIALS_SECRET;
  if (!secret) {
    throw new ConnectorConfigError(
      'CREDENTIALS_SECRET is not set. Add it as a GitHub secret and re-run the deploy.',
    );
  }
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: enc.encode('mana-credentials-v1'),
      info: new Uint8Array(),
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export type Credentials = Record<string, string>;

/** The saved credentials of one connection, or {} when none were saved. */
export async function loadCredentials(env: Env, connectionId: string): Promise<Credentials> {
  const row = await env.DB.prepare(
    'SELECT iv, ciphertext FROM connection_credentials WHERE connection_id = ?',
  )
    .bind(connectionId)
    .first<{ iv: string; ciphertext: string }>();
  if (!row) return {};
  const key = await keyFor(env);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(row.iv) },
      key,
      fromBase64(row.ciphertext),
    );
    return JSON.parse(dec.decode(plain)) as Credentials;
  } catch {
    throw new ConnectorConfigError(
      'Saved credentials could not be decrypted. CREDENTIALS_SECRET has changed; link the account again.',
    );
  }
}

/**
 * Saves credentials for a connection. By default the new values are merged
 * into what is already saved (a rotated Questrade token must not erase the
 * other values); pass replace: true to overwrite everything.
 */
export async function saveCredentials(
  env: Env,
  connectionId: string,
  values: Credentials,
  opts: { replace?: boolean } = {},
): Promise<void> {
  await (await prepareCredentials(env, connectionId, values, opts)).run();
}

/** The same encrypted write, for callers that commit credentials with other effects atomically. */
export async function prepareCredentials(
  env: Env,
  connectionId: string,
  values: Credentials,
  opts: { replace?: boolean } = {},
): Promise<D1PreparedStatement> {
  const key = await keyFor(env);
  const merged = opts.replace
    ? { ...values }
    : { ...(await loadCredentials(env, connectionId)), ...values };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(JSON.stringify(merged)),
  );
  return env.DB.prepare(
    `INSERT INTO connection_credentials (connection_id, iv, ciphertext, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (connection_id) DO UPDATE SET iv = excluded.iv,
       ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`,
  ).bind(connectionId, toBase64(iv), toBase64(new Uint8Array(cipher)), nowIso());
}

export async function deleteCredentials(env: Env, connectionId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM connection_credentials WHERE connection_id = ?')
    .bind(connectionId)
    .run();
}
