import type { ConnectorContext } from '@manaclaude/shared';
import {
  ConnectorRateLimitedError,
  ProviderDataError,
  ProviderHttpError,
  repairNeeded,
} from './errors';

/** Tests replace sleep so retry tests do not wait. */
export const httpRuntime = {
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};

export type Query = Record<
  string,
  string | number | boolean | null | undefined | readonly string[]
>;

export interface SignInput {
  method: string;
  url: string;
  path: string;
  query: string;
  body: string | undefined;
}

export interface HttpClientOptions {
  /** Shown in errors ("Teller", "Plaid"). */
  provider: string;
  baseUrl: string;
  headers?: Record<string, string>;
  /** Status codes that mean "the user must repair this login". Default 401 and 403. */
  repairStatuses?: readonly number[];
  /** Look at an error body and decide it needs repair (Plaid ITEM_LOGIN_REQUIRED). */
  needsRepair?: (status: number, body: unknown) => string | null;
  /** Add headers computed from the request (signatures). */
  sign?: (input: SignInput) => Promise<Record<string, string>>;
  /** Extra attempts after a 429, 5xx or network error. Default 2. */
  retries?: number;
  /**
   * Answer a challenge once: look at a failed response (Wise's strong customer
   * authentication) and return headers to retry the same request with, or null.
   */
  challenge?: (res: {
    status: number;
    headers: { get(name: string): string | null };
  }) => Promise<Record<string, string> | null>;
}

export interface RequestOptions {
  query?: Query;
  json?: unknown;
  form?: Record<string, string | number | boolean | undefined | null>;
  /** Raw body, for providers that sign the exact bytes. */
  body?: string;
  headers?: Record<string, string>;
  /** Return the response text instead of parsing JSON (XML, CSV). */
  text?: boolean;
}

export function buildQuery(query: Query | undefined): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    const values = Array.isArray(value) ? (value as readonly string[]) : [String(value)];
    for (const v of values) parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return parts.join('&');
}

export function encodeForm(
  form: Record<string, string | number | boolean | undefined | null>,
): string {
  return buildQuery(form as Query);
}

function retryAfter(headers: { get(name: string): string | null }): number | null {
  const raw = headers.get('retry-after');
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Thin JSON client over the Worker's fetch. It turns auth failures into
 * ConnectorRepairNeededError (so the connection shows "Repair"), rate limits
 * into ConnectorRateLimitedError, and keeps response bodies out of messages.
 */
export class HttpClient {
  constructor(
    private readonly ctx: ConnectorContext,
    private readonly options: HttpClientOptions,
  ) {}

  async request<T = unknown>(method: string, path: string, req: RequestOptions = {}): Promise<T> {
    const { provider } = this.options;
    const query = buildQuery(req.query);
    const base = /^https?:\/\//.test(path) ? path : this.options.baseUrl.replace(/\/$/, '') + path;
    const url = query ? `${base}${base.includes('?') ? '&' : '?'}${query}` : base;
    let body = req.body;
    const headers: Record<string, string> = { Accept: 'application/json', ...this.options.headers };
    if (req.json !== undefined) {
      body = JSON.stringify(req.json);
      headers['Content-Type'] = 'application/json';
    } else if (req.form) {
      body = encodeForm(req.form);
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    Object.assign(headers, req.headers);
    if (this.options.sign) {
      Object.assign(
        headers,
        await this.options.sign({
          method: method.toUpperCase(),
          url,
          path: base.replace(/^https?:\/\/[^/]+/, ''),
          query,
          body,
        }),
      );
    }

    const maxAttempts = (this.options.retries ?? 2) + 1;
    let lastError: unknown;
    let challenged = false;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let res: Awaited<ReturnType<ConnectorContext['fetch']>>;
      try {
        res = await this.ctx.fetch(url, { method: method.toUpperCase(), headers, body });
      } catch (error) {
        lastError = new ProviderHttpError(provider, 0, error instanceof Error ? error.message : '');
        await httpRuntime.sleep(250 * 2 ** attempt);
        continue;
      }
      if (res.ok) {
        if (res.status === 204) return undefined as T;
        const text = await res.text();
        if (req.text) return text as T;
        if (text.trim() === '') return undefined as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new ProviderDataError(provider, 'not JSON');
        }
      }

      if (this.options.challenge && !challenged) {
        const extra = await this.options.challenge(res);
        if (extra) {
          challenged = true;
          Object.assign(headers, extra);
          attempt--; // the challenge answer is not a retry
          continue;
        }
      }
      const text = await res.text().catch(() => '');
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // keep the text
      }
      const custom = this.options.needsRepair?.(res.status, parsed);
      if (custom) throw repairNeeded(provider, custom);
      if ((this.options.repairStatuses ?? [401, 403]).includes(res.status)) {
        throw repairNeeded(provider);
      }
      if (res.status === 429) {
        const wait = retryAfter(res.headers);
        lastError = new ConnectorRateLimitedError(provider, wait, text);
        if (attempt + 1 < maxAttempts)
          await httpRuntime.sleep(Math.min((wait ?? 1) * 1000, 10_000));
        continue;
      }
      // 501 and 505 are answers, not outages: do not retry them.
      if (res.status >= 500 && res.status !== 501 && res.status !== 505) {
        lastError = new ProviderHttpError(provider, res.status, text);
        await httpRuntime.sleep(250 * 2 ** attempt);
        continue;
      }
      throw new ProviderHttpError(provider, res.status, text);
    }
    throw lastError instanceof Error ? lastError : new ProviderHttpError(provider, 0);
  }

  get<T = unknown>(path: string, query?: Query, extra: RequestOptions = {}): Promise<T> {
    return this.request<T>('GET', path, { ...extra, query });
  }

  post<T = unknown>(path: string, json?: unknown, extra: RequestOptions = {}): Promise<T> {
    return this.request<T>('POST', path, { ...extra, json });
  }
}

/** Follow `nextLink(page)` until it returns null. Stops at `maxPages` so a bad cursor cannot loop forever. */
export async function collectPages<TPage, TItem>(
  fetchPage: (cursor: string | null) => Promise<TPage>,
  itemsOf: (page: TPage) => readonly TItem[],
  nextOf: (page: TPage, items: readonly TItem[]) => string | null,
  maxPages = 200,
): Promise<TItem[]> {
  const out: TItem[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (let i = 0; i < maxPages; i++) {
    const page = await fetchPage(cursor);
    const items = itemsOf(page);
    out.push(...items);
    const next = nextOf(page, items);
    if (next === null || seen.has(next)) break;
    seen.add(next);
    cursor = next;
  }
  return out;
}
