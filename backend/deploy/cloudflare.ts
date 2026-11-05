import { createHash } from 'node:crypto';
import { CERT_NAME_PREFIX } from './names.ts';

interface Envelope<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
  result_info?: { page: number; total_pages: number };
}

export class CloudflareError extends Error {
  status: number;
  codes: number[];
  constructor(message: string, status: number, codes: number[]) {
    super(message);
    this.name = 'CloudflareError';
    this.status = status;
    this.codes = codes;
  }
}

/** A thin client for the few Cloudflare REST calls the deploy needs. The token is only sent as a header. */
export class CloudflareApi {
  token: string;
  accountId: string;
  fetchFn: typeof fetch;
  base = 'https://api.cloudflare.com/client/v4';

  constructor(token: string, accountId: string, fetchFn: typeof fetch = fetch) {
    this.token = token;
    this.accountId = accountId;
    this.fetchFn = fetchFn;
  }

  async call<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { allow404?: boolean } = {},
  ): Promise<{ result: T | null; envelope: Envelope<T> | null }> {
    const res = await this.fetchFn(`${this.base}/accounts/${this.accountId}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let envelope: Envelope<T> | null = null;
    try {
      envelope = (await res.json()) as Envelope<T>;
    } catch {
      envelope = null;
    }
    if (res.status === 404 && opts.allow404) return { result: null, envelope };
    if (!res.ok || !envelope?.success) {
      const errors = envelope?.errors ?? [];
      const detail = errors.map((e) => `${e.message} [code ${e.code}]`).join('; ');
      throw new CloudflareError(
        `Cloudflare ${method} ${path.split('?')[0]} failed (${res.status})${detail ? `: ${detail}` : ''}`,
        res.status,
        errors.map((e) => e.code),
      );
    }
    return { result: envelope.result, envelope };
  }
}

const R2_NOT_ENABLED = 10042;

function r2Help(e: unknown): never {
  if (
    e instanceof CloudflareError &&
    (e.codes.includes(R2_NOT_ENABLED) || /enable R2/i.test(e.message))
  ) {
    throw new Error(
      'R2 is not turned on for this Cloudflare account. Open the Cloudflare dashboard, choose R2 Object Storage, and turn it on once (a card may be asked for; the free 10 GB tier stays free). Then re-run this workflow.',
    );
  }
  throw e;
}

export async function ensureD1(
  api: CloudflareApi,
  name: string,
): Promise<{ id: string; created: boolean }> {
  const list = await api.call<{ uuid: string; name: string }[]>(
    'GET',
    `/d1/database?name=${encodeURIComponent(name)}&per_page=100`,
  );
  const found = (list.result ?? []).find((d) => d.name === name);
  if (found) return { id: found.uuid, created: false };
  const made = await api.call<{ uuid: string }>('POST', '/d1/database', { name });
  if (!made.result?.uuid) throw new Error('Cloudflare did not return the new D1 database id.');
  return { id: made.result.uuid, created: true };
}

export async function ensureR2(api: CloudflareApi, name: string): Promise<{ created: boolean }> {
  try {
    const got = await api.call('GET', `/r2/buckets/${encodeURIComponent(name)}`, undefined, {
      allow404: true,
    });
    if (got.result) return { created: false };
  } catch (e) {
    // A missing bucket answers 404 (handled above); any other failure may be "R2 not enabled".
    if (!(e instanceof CloudflareError && e.status === 404)) r2Help(e);
  }
  try {
    await api.call('POST', '/r2/buckets', { name });
  } catch (e) {
    r2Help(e);
  }
  return { created: true };
}

export async function ensureKv(
  api: CloudflareApi,
  titles: readonly string[],
): Promise<{ id: string; title: string; created: boolean }> {
  for (let page = 1; page <= 20; page += 1) {
    const list = await api.call<{ id: string; title: string }[]>(
      'GET',
      `/storage/kv/namespaces?per_page=100&page=${page}`,
    );
    const rows = list.result ?? [];
    for (const title of titles) {
      const found = rows.find((n) => n.title === title);
      if (found) return { id: found.id, title, created: false };
    }
    const totalPages = list.envelope?.result_info?.total_pages ?? 1;
    if (page >= totalPages) break;
  }
  const title = titles[0];
  if (!title) throw new Error('No KV namespace title given.');
  const made = await api.call<{ id: string }>('POST', '/storage/kv/namespaces', { title });
  if (!made.result?.id) throw new Error('Cloudflare did not return the new KV namespace id.');
  return { id: made.result.id, title, created: true };
}

/** The certificate name follows its content, so a rotated certificate gets a new upload and an unchanged one is reused. */
export function certificateName(certPem: string): string {
  const digest = createHash('sha256').update(certPem.trim()).digest('hex');
  return `${CERT_NAME_PREFIX}${digest.slice(0, 12)}`;
}

export async function ensureMtlsCertificate(
  api: CloudflareApi,
  certPem: string,
  keyPem: string,
): Promise<{ id: string; created: boolean }> {
  const name = certificateName(certPem);
  const list = await api.call<{ id: string; name: string }[]>('GET', '/mtls_certificates');
  const found = (list.result ?? []).find((c) => c.name === name);
  if (found) return { id: found.id, created: false };
  const made = await api.call<{ id: string }>('POST', '/mtls_certificates', {
    name,
    certificates: certPem.trim(),
    private_key: keyPem.trim(),
    ca: false,
  });
  if (!made.result?.id) throw new Error('Cloudflare did not return the new certificate id.');
  return { id: made.result.id, created: true };
}

/** The account's workers.dev subdomain, registering one when the account has none yet. */
export async function ensureWorkersSubdomain(
  api: CloudflareApi,
  suggestion: string,
): Promise<{ subdomain: string; created: boolean }> {
  const got = await api.call<{ subdomain?: string | null }>(
    'GET',
    '/workers/subdomain',
    undefined,
    {
      allow404: true,
    },
  );
  if (got.result?.subdomain) return { subdomain: got.result.subdomain, created: false };
  const made = await api.call<{ subdomain?: string }>('PUT', '/workers/subdomain', {
    subdomain: suggestion,
  });
  if (!made.result?.subdomain)
    throw new Error('Cloudflare did not return the workers.dev subdomain.');
  return { subdomain: made.result.subdomain, created: true };
}

/** A subdomain name that is stable for the account and unlikely to be taken. */
export function suggestSubdomain(accountId: string): string {
  return `manaclaude-${createHash('sha256').update(accountId).digest('hex').slice(0, 8)}`;
}

/** The Pages project's address (for example manaclaude.pages.dev), creating the project when missing. */
export async function ensurePagesProject(
  api: CloudflareApi,
  name: string,
  productionBranch = 'main',
): Promise<{ url: string; created: boolean }> {
  const got = await api.call<{ subdomain?: string }>(
    'GET',
    `/pages/projects/${encodeURIComponent(name)}`,
    undefined,
    { allow404: true },
  );
  if (got.result?.subdomain) return { url: `https://${got.result.subdomain}`, created: false };
  const made = await api.call<{ subdomain?: string }>('POST', '/pages/projects', {
    name,
    production_branch: productionBranch,
  });
  const sub = made.result?.subdomain ?? `${name}.pages.dev`;
  return { url: `https://${sub}`, created: true };
}
