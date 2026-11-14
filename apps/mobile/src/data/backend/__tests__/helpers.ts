import { http } from '../client';

/**
 * A stand-in for the Worker in tests. Each request is matched to a handler by
 * "METHOD /path"; a handler answers at once or returns a `held()` answer the
 * test lets go later, to play a slow network. All data is invented.
 */
export interface Call {
  method: string;
  url: string;
  path: string;
  token: string;
  body: unknown;
  /** The fetch cache mode asked for, if any. */
  cache: RequestCache | undefined;
  aborted: () => boolean;
}

export interface Held {
  promise: Promise<Response>;
  release: (status: number, body: unknown) => void;
  fail: () => void;
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

/** An answer that waits until the test calls `release` or `fail`. */
export function held(): Held {
  let release!: Held['release'];
  let fail!: Held['fail'];
  const promise = new Promise<Response>((resolve, reject) => {
    release = (status, body) => resolve(json(status, body));
    fail = () => reject(new TypeError('Network request failed'));
  });
  return { promise, release, fail };
}

type Handler = (call: Call) => Response | Promise<Response>;

export function fakeBackend(handlers: Record<string, Handler>) {
  const calls: Call[] = [];
  const real = http.fetch;
  http.fetch = (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    const call: Call = {
      method,
      url: url.origin,
      path: url.pathname,
      token: ((init?.headers ?? {}) as Record<string, string>).authorization ?? '',
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      cache: init?.cache,
      aborted: () => init?.signal?.aborted ?? false,
    };
    calls.push(call);
    const handler = handlers[`${method} ${url.pathname}`];
    if (!handler) return Promise.resolve(json(404, { error: 'not_found', message: '' }));
    return Promise.resolve(handler(call));
  };
  return {
    calls,
    /** Requests so far for one "METHOD /path". */
    sent: (key: string) => calls.filter((c) => `${c.method} ${c.path}` === key),
    restore: () => {
      http.fetch = real;
    },
  };
}

/** Lets promise chains and storage reads that are already queued finish. */
export async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise<void>((r) => setImmediate(r));
}
