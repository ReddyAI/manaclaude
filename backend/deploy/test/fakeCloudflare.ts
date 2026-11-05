/** A stateful stand-in for the Cloudflare REST API, enough for deploy/prepare.ts. */
export interface FakeState {
  d1: { uuid: string; name: string }[];
  r2: string[];
  kv: { id: string; title: string }[];
  certs: { id: string; name: string }[];
  subdomain: string | null;
  pages: { name: string; subdomain: string }[];
  r2Enabled: boolean;
  calls: { method: string; path: string; body: unknown; auth: string | null }[];
}

export function newState(over: Partial<FakeState> = {}): FakeState {
  return {
    d1: [],
    r2: [],
    kv: [],
    certs: [],
    subdomain: null,
    pages: [],
    r2Enabled: true,
    calls: [],
    ...over,
  };
}

let counter = 0;
const id = (): string => `id${(counter += 1).toString().padStart(30, '0')}`;

function reply(
  status: number,
  result: unknown,
  errors: { code: number; message: string }[] = [],
  info?: unknown,
) {
  const body = {
    success: status < 300,
    errors,
    messages: [],
    result,
    ...(info ? { result_info: info } : {}),
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function fakeCloudflare(state: FakeState, account = 'acct123'): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const prefix = `/client/v4/accounts/${account}`;
    if (!url.pathname.startsWith(prefix))
      return reply(404, null, [{ code: 7003, message: 'No route' }]);
    const path = url.pathname.slice(prefix.length);
    state.calls.push({
      method,
      path: path + url.search,
      body,
      auth: headers.authorization ?? null,
    });

    if (path === '/d1/database' && method === 'GET') {
      const name = url.searchParams.get('name');
      return reply(
        200,
        state.d1.filter((d) => !name || d.name.includes(name)),
      );
    }
    if (path === '/d1/database' && method === 'POST') {
      const row = { uuid: id(), name: body.name as string };
      state.d1.push(row);
      return reply(200, row);
    }
    if (path.startsWith('/r2/buckets')) {
      if (!state.r2Enabled)
        return reply(403, null, [
          { code: 10042, message: 'Please enable R2 through the Cloudflare Dashboard.' },
        ]);
      if (method === 'GET') {
        const name = decodeURIComponent(path.split('/')[3] ?? '');
        return state.r2.includes(name)
          ? reply(200, { name })
          : reply(404, null, [{ code: 10006, message: 'The specified bucket does not exist.' }]);
      }
      state.r2.push(body.name as string);
      return reply(200, { name: body.name });
    }
    if (path === '/storage/kv/namespaces' && method === 'GET') {
      const page = Number(url.searchParams.get('page') ?? '1');
      const per = 2; // small pages, to exercise paging
      const rows = state.kv.slice((page - 1) * per, page * per);
      return reply(200, rows, [], {
        page,
        total_pages: Math.max(1, Math.ceil(state.kv.length / per)),
      });
    }
    if (path === '/storage/kv/namespaces' && method === 'POST') {
      const row = { id: id(), title: body.title as string };
      state.kv.push(row);
      return reply(200, row);
    }
    if (path === '/mtls_certificates' && method === 'GET') return reply(200, state.certs);
    if (path === '/mtls_certificates' && method === 'POST') {
      const row = { id: id(), name: body.name as string };
      state.certs.push(row);
      return reply(200, row);
    }
    if (path === '/workers/subdomain' && method === 'GET')
      return reply(200, { subdomain: state.subdomain });
    if (path === '/workers/subdomain' && method === 'PUT') {
      state.subdomain = body.subdomain as string;
      return reply(200, { subdomain: state.subdomain });
    }
    if (path.startsWith('/pages/projects/') && method === 'GET') {
      const name = decodeURIComponent(path.split('/')[3] ?? '');
      const p = state.pages.find((x) => x.name === name);
      return p
        ? reply(200, p)
        : reply(404, null, [{ code: 8000007, message: 'Project not found.' }]);
    }
    if (path === '/pages/projects' && method === 'POST') {
      const row = { name: body.name as string, subdomain: `${body.name as string}.pages.dev` };
      state.pages.push(row);
      return reply(200, row);
    }
    return reply(404, null, [{ code: 7003, message: `No route for ${method} ${path}` }]);
  }) as typeof fetch;
}
