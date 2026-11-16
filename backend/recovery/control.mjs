// Dependency-free pause: it runs before npm install, so later setup failures
// cannot accidentally leave writers enabled. Uses only the existing CF secrets.
import { createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export async function control(mode, env = process.env, transport = fetch) {
  if (env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch')
    throw new Error('Use main');
  if (!['pause', 'on', 'off', 'status'].includes(mode)) throw new Error('Invalid mode');
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID)
    throw new Error('Missing configured credentials');
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const sub = await transport(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/subdomain`,
    {
      headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    },
  );
  const data = await sub.json();
  if (!sub.ok || !data.success || !/^[a-z0-9-]+$/i.test(data.result?.subdomain ?? ''))
    throw new Error('Production origin not found');
  const token = createHmac('sha256', env.CLOUDFLARE_API_TOKEN)
    .update('billionaire-recovery-v1:' + account)
    .digest('hex');
  const request = async (path, body) => {
    const response = await transport(
      `https://manaclaude-api.${data.result.subdomain}.workers.dev/__recovery/${path}`,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!response.ok) throw new Error('Maintenance control unavailable');
    const state = await response.json();
    if (
      typeof state.on !== 'boolean' ||
      !Number.isSafeInteger(state.active) ||
      !Number.isSafeInteger(state.generation) ||
      state.active < 0 ||
      typeof state.drained !== 'boolean' ||
      (state.drained && (!state.on || state.active !== 0))
    )
      throw new Error('Invalid maintenance state');
    return state;
  };
  let status = await request('status');
  if (status.protocol !== 1) throw new Error('Install the reviewed maintenance release first');
  if (mode !== 'status')
    status = await request(
      'maintenance',
      mode === 'off' ? { on: false, generation: status.generation } : { on: true },
    );
  if ((mode === 'off' && status.on) || (['on', 'pause'].includes(mode) && !status.on))
    throw new Error('Requested hold state was not confirmed');
  if (mode === 'on') {
    const end = Date.now() + 30 * 60_000;
    while (!status.drained) {
      if (!status.on || Date.now() >= end) throw new Error('Drain not confirmed');
      await new Promise((r) => setTimeout(r, 5_000));
      status = await request('status');
    }
  }
  return {
    maintenance: Number(status.on),
    activeWriters: status.active,
    drained: Number(status.drained),
  };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  control(process.argv[2])
    .then((value) => process.stdout.write(JSON.stringify(value) + '\n'))
    .catch(() => {
      console.error(
        '::error::Maintenance could not be confirmed or changed. Do not assume it is off or drained. Install the reviewed release if this is the first run; otherwise inspect Maintenance status.',
      );
      process.exitCode = 1;
    });
}
