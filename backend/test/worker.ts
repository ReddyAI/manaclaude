import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { createWorker } from '../src/worker';
import type { AppDeps } from '../src/api/app';
import type { Env } from '../src/env';
import { testEnv } from './helpers';

export const BASE = 'https://mana.test';
export const TOKEN = 'test-app-token';

/** Calls the whole Worker (OAuth wrapper, router, handlers) like a real client would. */
export function client(deps: AppDeps = {}, env: Env = testEnv) {
  const worker = createWorker(deps);
  const raw = async (input: string | Request, init?: RequestInit) => {
    const req =
      typeof input === 'string'
        ? new Request(input.startsWith('http') ? input : BASE + input, init)
        : input;
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };
  const api = async <T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    token: string | null = TOKEN,
  ) => {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await raw(path, { method, headers, body: payload });
    const text = await res.text();
    return {
      status: res.status,
      body: (text ? JSON.parse(text) : null) as T,
      headers: res.headers,
    };
  };
  return { raw, api, worker };
}

export function upload(
  fields: Record<string, string>,
  fileText: string | Uint8Array,
  name: string,
  type = 'text/csv',
) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  form.set('file', new File([fileText as BlobPart], name, { type }));
  return form;
}
