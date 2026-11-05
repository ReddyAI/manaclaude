/**
 * Small WebCrypto helpers shared by the signed-request adapters (Sophtron,
 * SnapTrade, Kraken, Binance, CoinSpot, WazirX, Coinbase). WebCrypto exists in
 * Cloudflare Workers and in Node 24, so the same code runs in both.
 */

export type Bytes = Uint8Array<ArrayBuffer>;

const encoder = new TextEncoder();

export function utf8(text: string): Bytes {
  return new Uint8Array(encoder.encode(text));
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function fromBase64(text: string): Bytes {
  const clean = text.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

type Input = string | Uint8Array;

function asBytes(input: Input): Bytes {
  return typeof input === 'string' ? utf8(input) : new Uint8Array(input);
}

export async function hmac(hash: 'SHA-256' | 'SHA-512', key: Input, data: Input): Promise<Bytes> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    asBytes(key),
    { name: 'HMAC', hash },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, asBytes(data)));
}

export async function sha256(data: Input): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', asBytes(data)));
}

export async function sha1Hex(data: Input): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-1', asBytes(data))));
}

// ---------------------------------------------------------------------------
// Minimal DER helpers: enough to turn the key formats Coinbase hands out into
// PKCS8, which is the only private-key format WebCrypto imports.
// ---------------------------------------------------------------------------

function derLength(length: number): Bytes {
  if (length < 0x80) return new Uint8Array([length]);
  if (length < 0x100) return new Uint8Array([0x81, length]);
  return new Uint8Array([0x82, length >> 8, length & 0xff]);
}

function der(tag: number, ...content: Uint8Array[]): Bytes {
  const body = concatBytes(...content);
  return concatBytes(new Uint8Array([tag]), derLength(body.length), body);
}

interface DerNode {
  tag: number;
  value: Bytes;
}

function readDer(bytes: Uint8Array, offset = 0): { node: DerNode; next: number } {
  const tag = bytes[offset] ?? 0;
  let length = bytes[offset + 1] ?? 0;
  let start = offset + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let i = 0; i < count; i++) length = (length << 8) | (bytes[start + i] ?? 0);
    start += count;
  }
  return {
    node: { tag, value: new Uint8Array(bytes.slice(start, start + length)) },
    next: start + length,
  };
}

function readSequence(bytes: Uint8Array): DerNode[] {
  const outer = readDer(bytes).node;
  const nodes: DerNode[] = [];
  let offset = 0;
  while (offset < outer.value.length) {
    const { node, next } = readDer(outer.value, offset);
    nodes.push(node);
    offset = next;
  }
  return nodes;
}

const OID_EC_PUBLIC_KEY = new Uint8Array([0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]);
const OID_P256 = new Uint8Array([0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]);
const OID_ED25519 = new Uint8Array([0x06, 0x03, 0x2b, 0x65, 0x70]);
const OID_RSA = new Uint8Array([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]);

/** "-----BEGIN EC PRIVATE KEY-----..." to its label and DER bytes. */
export function parsePem(pem: string): { label: string; der: Bytes } {
  const match = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(
    pem.replace(/\\n/g, '\n'),
  );
  if (!match) throw new Error('not a PEM key');
  return { label: match[1] ?? '', der: fromBase64((match[2] ?? '').replace(/\s+/g, '')) };
}

/** SEC1 "EC PRIVATE KEY" (P-256) to PKCS8. */
export function sec1ToPkcs8P256(sec1: Uint8Array): Bytes {
  const fields = readSequence(sec1);
  const privateKey = fields.find((f) => f.tag === 0x04)?.value;
  const publicKeyField = fields.find((f) => f.tag === 0xa1);
  if (!privateKey) throw new Error('EC key has no private part');
  const inner = der(
    0x30,
    der(0x02, new Uint8Array([1])),
    der(0x04, privateKey),
    ...(publicKeyField ? [der(0xa1, publicKeyField.value)] : []),
  );
  return der(
    0x30,
    der(0x02, new Uint8Array([0])),
    der(0x30, OID_EC_PUBLIC_KEY, OID_P256),
    der(0x04, inner),
  );
}

/** PKCS1 "RSA PRIVATE KEY" to PKCS8. */
export function rsaPkcs1ToPkcs8(pkcs1: Uint8Array): Bytes {
  return der(
    0x30,
    der(0x02, new Uint8Array([0])),
    der(0x30, OID_RSA, new Uint8Array([0x05, 0x00])),
    der(0x04, pkcs1),
  );
}

async function importRsa(pem: string): Promise<CryptoKey> {
  const { label, der: keyDer } = parsePem(pem);
  const pkcs8 = label === 'RSA PRIVATE KEY' ? rsaPkcs1ToPkcs8(keyDer) : keyDer;
  return crypto.subtle.importKey(
    'pkcs8',
    pkcs8,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

/** Base64 RSA-SHA256 signature of `message` (Wise strong customer authentication). */
export async function signRsaSha256(pem: string, message: string): Promise<string> {
  const key = await importRsa(pem);
  return toBase64(
    new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, utf8(message))),
  );
}

/** RS256 JWT (Enable Banking). */
export async function signJwtRs256(
  pem: string,
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
): Promise<string> {
  const key = await importRsa(pem);
  const message = `${toBase64Url(utf8(JSON.stringify({ ...header, alg: 'RS256', typ: 'JWT' })))}.${toBase64Url(utf8(JSON.stringify(payload)))}`;
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, utf8(message)));
  return `${message}.${toBase64Url(sig)}`;
}

export function ed25519SeedToPkcs8(seed: Uint8Array): Bytes {
  return der(
    0x30,
    der(0x02, new Uint8Array([0])),
    der(0x30, OID_ED25519),
    der(0x04, der(0x04, seed)),
  );
}

export type JwtAlg = 'ES256' | 'EdDSA';

/**
 * Sign a JWT with a PEM EC key (ES256) or a base64 Ed25519 secret (EdDSA).
 * Coinbase's Developer Platform keys come in both shapes.
 */
export async function signJwt(
  keyMaterial: string,
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
): Promise<string> {
  const isPem = keyMaterial.includes('-----BEGIN');
  let alg: JwtAlg;
  let key: CryptoKey;
  if (isPem) {
    const { label, der: keyDer } = parsePem(keyMaterial);
    const pkcs8 = label === 'EC PRIVATE KEY' ? sec1ToPkcs8P256(keyDer) : keyDer;
    key = await crypto.subtle.importKey(
      'pkcs8',
      pkcs8,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    );
    alg = 'ES256';
  } else {
    const raw = fromBase64(keyMaterial.trim());
    key = await crypto.subtle.importKey(
      'pkcs8',
      ed25519SeedToPkcs8(raw.slice(0, 32)),
      'Ed25519',
      false,
      ['sign'],
    );
    alg = 'EdDSA';
  }
  const encodedHeader = toBase64Url(utf8(JSON.stringify({ ...header, alg, typ: 'JWT' })));
  const encodedPayload = toBase64Url(utf8(JSON.stringify(payload)));
  const message = `${encodedHeader}.${encodedPayload}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : 'Ed25519',
      key,
      utf8(message),
    ),
  );
  return `${message}.${toBase64Url(signature)}`;
}

/** Random hex string for nonces. */
export function randomHex(byteCount = 16): string {
  return toHex(crypto.getRandomValues(new Uint8Array(byteCount)));
}
