import { describe, expect, it, vi } from 'vitest';

type Control = (
  mode: string,
  env: Record<string, string>,
  transport: typeof fetch,
) => Promise<{ maintenance: number; activeWriters: number; drained: number }>;
const control: Control = (await import(new URL('../control.mjs', import.meta.url).href)).control;
const env = {
  GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  CLOUDFLARE_API_TOKEN: 'invented-cf-token',
  CLOUDFLARE_ACCOUNT_ID: 'invented-account',
};

describe('dependency-free GitHub pause control', () => {
  it('closes admission without pretending an active writer has drained', async () => {
    const bodies: string[] = [];
    const transport = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith('/workers/subdomain'))
        return Response.json({ success: true, result: { subdomain: 'invented' } });
      if (init?.body) {
        bodies.push(String(init.body));
        return Response.json({ generation: 1, on: true, active: 1, drained: false });
      }
      return Response.json({ protocol: 1, generation: 1, on: false, active: 1, drained: false });
    });
    expect(await control('pause', env, transport as typeof fetch)).toEqual({
      maintenance: 1,
      activeWriters: 1,
      drained: 0,
    });
    expect(bodies).toEqual(['{"on":true}']);
    expect(transport.mock.calls.every(([, i]) => i?.redirect === 'error')).toBe(true);
  });
  it('waits for drain on the on button and never sends an off request during it', async () => {
    vi.useFakeTimers();
    let paused = false,
      reads = 0;
    const transport = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith('/workers/subdomain'))
        return Response.json({ success: true, result: { subdomain: 'invented' } });
      if (init?.body) {
        paused = true;
        return Response.json({ generation: 1, on: true, active: 1, drained: false });
      }
      const active = paused && ++reads > 0 ? 0 : 1;
      return Response.json({
        protocol: 1,
        generation: 1,
        on: paused,
        active,
        drained: paused && active === 0,
      });
    });
    try {
      const result = control('on', env, transport as typeof fetch);
      await vi.runAllTimersAsync();
      expect(await result).toEqual({ maintenance: 1, activeWriters: 0, drained: 1 });
      expect(transport.mock.calls.filter(([, i]) => i?.body).map(([, i]) => i?.body)).toEqual([
        '{"on":true}',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
  it('rejects untrusted refs and invalid input without contacting any service', async () => {
    const transport = vi.fn();
    await expect(
      control('pause', { ...env, GITHUB_REF: 'refs/heads/untrusted' }, transport),
    ).rejects.toThrow();
    await expect(control('unexpected', env, transport)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it('cannot mistake a failed pause or an inconsistent state for a successful hold', async () => {
    let bad = false;
    const transport = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith('/workers/subdomain'))
        return Response.json({ success: true, result: { subdomain: 'invented' } });
      if (init?.body)
        return bad
          ? Response.json({ generation: 1, on: false, active: 0, drained: true })
          : new Response('invented private provider detail', { status: 503 });
      return Response.json({ protocol: 1, generation: 1, on: false, active: 0, drained: false });
    });
    await expect(control('pause', env, transport as typeof fetch)).rejects.toThrow(
      'Maintenance control unavailable',
    );
    bad = true;
    await expect(control('pause', env, transport as typeof fetch)).rejects.toThrow(
      'Invalid maintenance state',
    );
  });
});
