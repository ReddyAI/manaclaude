import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Connection, ConnectorContext, FetchLike } from '@manaclaude/shared';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_ROOT = join(here, '..', '..', 'fixtures');

/** Read connectors/fixtures/<connector>/<file>. JSON files are parsed; others come back as text. */
export function fixture<T = unknown>(connector: string, file: string): T {
  const text = readFileSync(join(FIXTURE_ROOT, connector, file), 'utf8');
  return (file.endsWith('.json') ? JSON.parse(text) : text) as T;
}

export interface FakeReply {
  status?: number;
  /** Object to send as JSON. */
  json?: unknown;
  /** Raw text (XML, CSV). */
  text?: string;
  headers?: Record<string, string>;
}

export interface FakeCall {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string | undefined;
}

export type FakeHandler = FakeReply | ((call: FakeCall, n: number) => FakeReply);

/**
 * A fetch that answers from saved fixtures. Routes are "METHOD host/path"
 * strings without the query string; the handler sees the query through
 * call.url and can page on it. A request with no route fails the test.
 */
export function fakeFetch(routes: Record<string, FakeHandler>): FetchLike & { calls: FakeCall[] } {
  const counts = new Map<string, number>();
  const calls: FakeCall[] = [];
  const fn = (async (url, init) => {
    const u = new URL(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const call: FakeCall = { method, url: u, headers: init?.headers ?? {}, body: init?.body };
    calls.push(call);
    const key = `${method} ${u.host}${u.pathname}`;
    // Exact route first, then a "...*" prefix route (for ids and time windows in the path).
    const handler =
      routes[key] ??
      Object.entries(routes).find(([k]) => k.endsWith('*') && key.startsWith(k.slice(0, -1)))?.[1];
    if (!handler) throw new Error(`fakeFetch: no route for ${key}${u.search}`);
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    const reply = typeof handler === 'function' ? handler(call, n) : handler;
    const status = reply.status ?? 200;
    const text = reply.text ?? (reply.json === undefined ? '' : JSON.stringify(reply.json));
    const headers = reply.headers ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? headers[name] ?? null },
      json: async () => JSON.parse(text) as unknown,
      text: async () => text,
    };
  }) as FetchLike & { calls: FakeCall[] };
  fn.calls = calls;
  return fn;
}

export const NOW = new Date('2026-11-05T12:00:00.000Z');

export function makeCtx(
  secrets: Record<string, string>,
  fetch: FetchLike,
  now: Date = NOW,
): ConnectorContext {
  return { secrets, fetch, now: () => now };
}

export function makeConnection(connectorId: string, over: Partial<Connection> = {}): Connection {
  return {
    id: `conn_${connectorId}`,
    connectorId,
    institutionName: 'Test Institution',
    status: 'healthy',
    lastSyncAt: null,
    lastSuccessfulSyncAt: null,
    lastError: null,
    syncCursor: null,
    accountIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}
