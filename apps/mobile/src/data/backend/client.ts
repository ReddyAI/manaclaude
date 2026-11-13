import { getBackendConfig, subscribeBackendConfig } from './config';

/**
 * The app's calls to the Worker's /v1 API. Every request carries the bearer
 * token. Errors come back as BackendError with a message written for a person
 * ("The backend can't be reached", "The API token is wrong"), never a stack.
 */

export class BackendError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BackendError';
  }

  /** The request never reached the Worker (offline, wrong URL, DNS). */
  get offline(): boolean {
    return this.status === 0 && this.code !== 'superseded';
  }

  /**
   * The backend address or token changed (or the token was forgotten) while
   * this request was on its way. Its answer belongs to the old backend and
   * was thrown away.
   */
  get superseded(): boolean {
    return this.code === 'superseded';
  }
}

/** True for a request dropped because the backend settings changed under it. */
export function isSuperseded(e: unknown): boolean {
  return e instanceof BackendError && e.superseded;
}

export function supersededError(): BackendError {
  return new BackendError(
    0,
    'superseded',
    'The backend settings changed while this was loading, so its answer was ignored. Try again.',
  );
}

// Requests made with the saved URL and token, still waiting for an answer.
// When the saved backend changes they are aborted; any answer that arrives
// anyway is dropped in api() below.
const pending = new Set<AbortController>();
let watchedScope: string | null = null;
let watching = false;

function watchConfig(): void {
  if (watching) return;
  watching = true;
  watchedScope = getBackendConfig().scope;
  subscribeBackendConfig(() => {
    const scope = getBackendConfig().scope;
    if (scope === watchedScope) return;
    watchedScope = scope;
    for (const c of [...pending]) c.abort();
    pending.clear();
  });
}

const TIMEOUT_MS = 30_000;

/** Replaced in tests. */
export const http = {
  fetch: (input: string, init?: RequestInit): Promise<Response> => fetch(input, init),
};

function message(status: number, code: string, fallback: string): string {
  if (status === 401) return 'The API token is wrong. Check it in Settings, Backend.';
  if (status === 503 && code === 'not_configured') return fallback;
  if (status === 404 && code === 'not_found' && !fallback) return 'Not found.';
  return fallback || `The backend answered with an error (HTTP ${status}).`;
}

export async function api<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: { timeoutMs?: number; url?: string; token?: string; acceptStatus?: number[] } = {},
): Promise<T> {
  watchConfig();
  const cfg = getBackendConfig();
  const base = (opts.url ?? cfg.url).replace(/\/+$/, '');
  const token = opts.token ?? cfg.token;
  if (!base || !token)
    throw new BackendError(0, 'not_set', 'Set the backend URL and API token in Settings, Backend.');
  // A call that names its own URL and token (the check before saving in
  // Settings) is not tied to the saved backend.
  const scoped = opts.url === undefined && opts.token === undefined;
  const stale = () => scoped && getBackendConfig().scope !== cfg.scope;
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  const timer = controller
    ? setTimeout(() => controller.abort(), opts.timeoutMs ?? TIMEOUT_MS)
    : null;
  if (scoped && controller) pending.add(controller);
  let res: Response;
  let text: string;
  try {
    res = await http.fetch(`${base}${path}`, {
      method,
      headers,
      body: payload,
      signal: controller?.signal,
    });
    text = await res.text().catch(() => '');
  } catch {
    if (stale()) throw supersededError();
    throw new BackendError(
      0,
      'offline',
      "The backend can't be reached. Check your connection and the URL in Settings, Backend.",
    );
  } finally {
    if (timer) clearTimeout(timer);
    if (controller) pending.delete(controller);
  }
  if (stale()) throw supersededError();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok && !opts.acceptStatus?.includes(res.status)) {
    const err = (parsed ?? {}) as { error?: string; message?: string };
    throw new BackendError(
      res.status,
      err.error ?? 'error',
      message(res.status, err.error ?? '', err.message ?? ''),
    );
  }
  return parsed as T;
}

/** Turns any error into one plain sentence for the screen. */
export function errorText(e: unknown): string {
  if (e instanceof BackendError) return e.message;
  return 'Something went wrong. Try again.';
}
