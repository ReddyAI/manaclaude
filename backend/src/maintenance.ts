import type { Env } from './env';
import { safeEqual } from './util/ids';
import { READ_TOOLS } from './mcp/tools';

export const maintenanceResponse = () =>
  Response.json(
    {
      error: 'maintenance',
      message: 'Maintenance is on. Reads remain available; try writes later.',
    },
    { status: 503, headers: { 'retry-after': '60', 'cache-control': 'no-store' } },
  );

interface Control {
  on: boolean;
  generation: number;
  readyAt: number;
  allowedRelease: string;
  proof?: string;
}
/** A durable admission ledger. Entries NEVER expire: a crash must block, not fake, drain. */
export class MaintenanceCoordinator {
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    // Preserve the existing loopback sample-seed/browser harness without opening
    // a production bypass. Deployment provenance separately verifies PUBLIC_URL.
    const testing =
      this.env.MAINTENANCE_TEST_DEFAULT === 'off' ||
      (this.env.ALLOW_SAMPLE_SEED === 'true' &&
        /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/?$/.test(this.env.PUBLIC_URL ?? ''));
    const input = (await request.json()) as {
      action: string;
      token?: string;
      proof?: string;
      release?: string;
      generation?: number;
    };
    return this.state.storage.transaction(async (storage) => {
      const control = (await storage.get<Control>('control')) ?? {
        on: !testing,
        generation: 0,
        allowedRelease: this.env.RELEASE_COMMIT ?? '',
        // Initial installation also quarantines pre-instrumentation invocations:
        // Cover the platform's 20-minute runtime retirement grace as well as
        // 15-minute scheduled invocations. Never expire actual ledger entries.
        readyAt: Date.now() + (testing ? 0 : 21 * 60_000),
      };
      if (input.action === 'on' || input.action === 'off') {
        if (
          input.action === 'off' &&
          ((await storage.list({ prefix: 'writer:' })).size ||
            Date.now() < control.readyAt ||
            input.generation !== control.generation ||
            input.release !== control.allowedRelease ||
            (!testing && !/^[a-f0-9]{40}$/.test(input.release ?? '')))
        )
          return maintenanceResponse();
        control.on = input.action === 'on';
        control.generation++;
        delete control.proof;
      } else if (input.action === 'admit') {
        if (control.on || input.release !== control.allowedRelease) return maintenanceResponse();
        if (!input.token) return new Response(null, { status: 400 });
        await storage.put('writer:' + input.token, true);
      } else if (input.action === 'finish') {
        if (!input.token) return new Response(null, { status: 400 });
        await storage.delete('writer:' + input.token);
      } else if (input.action === 'activate') {
        if (
          !control.on ||
          (await storage.list({ prefix: 'writer:' })).size ||
          Date.now() < control.readyAt ||
          input.generation !== control.generation ||
          !/^[a-f0-9]{40}$/.test(input.release ?? '')
        )
          return maintenanceResponse();
        control.allowedRelease = input.release!;
        control.generation++;
        delete control.proof;
      } else if (input.action === 'proof') {
        if (
          !control.on ||
          (await storage.list({ prefix: 'writer:' })).size ||
          Date.now() < control.readyAt ||
          input.generation !== control.generation ||
          input.release !== control.allowedRelease ||
          !/^[a-f0-9]{64}$/.test(input.proof ?? '')
        )
          return maintenanceResponse();
        control.proof = input.proof;
      } else if (input.action !== 'status') return new Response(null, { status: 400 });
      await storage.put('control', control);
      const active = (await storage.list({ prefix: 'writer:' })).size;
      return Response.json({
        ...control,
        active,
        drained: control.on && active === 0 && Date.now() >= control.readyAt,
      });
    });
  }
}

export function coordinator(env: Env, action: string, extra: Record<string, string | number> = {}) {
  if (!env.MAINTENANCE) throw new Error('Maintenance coordinator is unavailable');
  return env.MAINTENANCE.get(env.MAINTENANCE.idFromName('production')).fetch(
    'https://maintenance.internal/',
    {
      method: 'POST',
      body: JSON.stringify({ action, release: env.RELEASE_COMMIT ?? '', ...extra }),
    },
  );
}

export async function readRequest(request: Request): Promise<boolean> {
  const path = new URL(request.url).pathname;
  if (request.method === 'OPTIONS') return true;
  if (request.method === 'GET' || request.method === 'HEAD') {
    if (path === '/health' || path.startsWith('/.well-known/')) return true;
    // Exact audited routes. New GET endpoints require admission until reviewed.
    return /^\/v1\/(?:dataset|accounts(?:\/[^/]+(?:\/deletion-preview)?)?|transactions(?:\/[^/]+)?|transfer-links|categories|rules|imports(?:\/[^/]+)?|import-mappings|vault(?:\/[^/]+\/file)?|receipts(?:\/[^/]+\/image)?|fx\/(?:latest|rates)|settings|ai\/status|alerts|recaps|recurring|connections|link\/options|history-policy(?:\/bank-reviews(?:\/[^/]+)?)?)$/.test(
      path,
    );
  }
  if (path !== '/mcp' || request.method !== 'POST') return false;
  try {
    const message = (await request.clone().json()) as {
      method?: string;
      params?: { name?: string };
    };
    return (
      [
        'initialize',
        'notifications/initialized',
        'ping',
        'tools/list',
        'resources/list',
        'prompts/list',
      ].includes(message.method ?? '') ||
      (message.method === 'tools/call' &&
        (READ_TOOLS as readonly string[]).includes(message.params?.name ?? ''))
    );
  } catch {
    return false;
  }
}

/** Include all waitUntil descendants in the writer's lifetime. */
export async function tracked<T>(
  env: Env,
  ctx: ExecutionContext,
  work: (ctx: ExecutionContext) => Promise<T>,
): Promise<T | Response> {
  const token = crypto.randomUUID();
  const admitted = await coordinator(env, 'admit', { token });
  if (!admitted.ok) return maintenanceResponse();
  const pending: Promise<unknown>[] = [];
  const wrapped = Object.create(ctx) as ExecutionContext;
  wrapped.waitUntil = (promise) => {
    pending.push(Promise.resolve(promise));
  };
  let result: T;
  try {
    result = await work(wrapped);
  } catch (error) {
    ctx.waitUntil(
      (async () => {
        for (let i = 0; i < pending.length; i++) await pending[i]!.catch(() => undefined);
        await coordinator(env, 'finish', { token });
      })(),
    );
    throw error;
  }
  const finish = async () => {
    for (let i = 0; i < pending.length; i++) await pending[i]!.catch(() => undefined);
    const response = await coordinator(env, 'finish', { token });
    if (!response.ok) throw new Error('Writer release failed');
  };
  if (pending.length) ctx.waitUntil(finish());
  else await finish();
  return result;
}

export async function operator(request: Request, env: Env): Promise<Response> {
  const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!env.RECOVERY_OPERATOR_TOKEN || !token || !safeEqual(token, env.RECOVERY_OPERATOR_TOKEN))
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  const url = new URL(request.url);
  const action = url.pathname.slice('/__recovery/'.length);
  if (action === 'status' && request.method === 'GET') {
    const response = await coordinator(env, 'status');
    return Response.json({
      ...((await response.json()) as object),
      protocol: 1,
      release: env.RELEASE_COMMIT ?? null,
    });
  }
  if (action === 'maintenance' && request.method === 'POST') {
    const body = (await request.json()) as { on?: boolean; generation?: number };
    if (typeof body.on !== 'boolean') return new Response(null, { status: 400 });
    if (!body.on && !Number.isSafeInteger(body.generation))
      return new Response(null, { status: 400 });
    return coordinator(
      env,
      body.on ? 'on' : 'off',
      body.on ? {} : { generation: body.generation! },
    );
  }
  const response = await coordinator(env, 'status');
  const status = (await response.json()) as { drained: boolean };
  if (!status.drained) return maintenanceResponse();
  if (action === 'proof' && request.method === 'POST') {
    const body = (await request.json()) as { proof: string; generation: number };
    return coordinator(env, 'proof', { proof: body.proof, generation: body.generation });
  }
  if (action === 'activate' && request.method === 'POST') {
    const body = (await request.json()) as { release: string; generation: number };
    return coordinator(env, 'activate', { release: body.release, generation: body.generation });
  }
  if (action === 'objects' && request.method === 'POST') {
    const body = (await request.json()) as { cursor?: string | null };
    const page = await env.FILES.list({
      cursor: body.cursor ?? undefined,
      limit: 100,
      include: ['httpMetadata', 'customMetadata'],
    });
    return Response.json({
      objects: page.objects.map((o) => ({
        key: o.key,
        bytes: o.size,
        etag: o.etag,
        httpMetadata: o.httpMetadata ?? {},
        customMetadata: o.customMetadata ?? {},
      })),
      cursor: page.truncated ? page.cursor : null,
    });
  }
  if (action === 'object' && request.method === 'POST') {
    const body = (await request.json()) as { key?: string };
    if (typeof body.key !== 'string') return new Response(null, { status: 400 });
    const object = await env.FILES.get(body.key);
    if (!object) return new Response(null, { status: 404 });
    return new Response(object.body, {
      headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' },
    });
  }
  return new Response(null, { status: 404 });
}
