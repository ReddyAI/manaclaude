import { describe, expect, it } from 'vitest';
import {
  CloudflareApi,
  CloudflareError,
  certificateName,
  ensureD1,
  ensureKv,
  ensureMtlsCertificate,
  ensurePagesProject,
  ensureR2,
  ensureWorkersSubdomain,
  suggestSubdomain,
} from '../cloudflare.ts';
import { fakeCloudflare, newState } from './fakeCloudflare.ts';

const apiFor = (state = newState()) => ({
  state,
  api: new CloudflareApi('tok_secret_value', 'acct123', fakeCloudflare(state)),
});

describe('Cloudflare REST helpers', () => {
  it('creates the D1 database once and then reuses it by exact name', async () => {
    const { api, state } = apiFor(
      newState({ d1: [{ uuid: 'other', name: 'manaclaude-staging' }] }),
    );
    const first = await ensureD1(api, 'manaclaude');
    expect(first.created).toBe(true);
    const again = await ensureD1(api, 'manaclaude');
    expect(again).toEqual({ id: first.id, created: false });
    expect(state.d1.map((d) => d.name).sort()).toEqual(['manaclaude', 'manaclaude-staging']);
  });

  it('creates the R2 bucket once, and explains when R2 is not turned on', async () => {
    const { api, state } = apiFor();
    expect(await ensureR2(api, 'manaclaude-files')).toEqual({ created: true });
    expect(await ensureR2(api, 'manaclaude-files')).toEqual({ created: false });
    expect(state.r2).toEqual(['manaclaude-files']);

    const off = apiFor(newState({ r2Enabled: false }));
    await expect(ensureR2(off.api, 'manaclaude-files')).rejects.toThrow(
      /R2 is not turned on.*dashboard/is,
    );
  });

  it('finds the KV namespace on a later page, by either known title, and creates it otherwise', async () => {
    const rows = [
      { id: 'k1', title: 'a' },
      { id: 'k2', title: 'b' },
      { id: 'k3', title: 'c' },
      { id: 'k4', title: 'manaclaude-api-OAUTH_KV' },
    ];
    const found = await ensureKv(apiFor(newState({ kv: rows })).api, [
      'manaclaude-oauth',
      'manaclaude-api-OAUTH_KV',
    ]);
    expect(found).toEqual({ id: 'k4', title: 'manaclaude-api-OAUTH_KV', created: false });

    const { api, state } = apiFor(newState({ kv: rows.slice(0, 3) }));
    const made = await ensureKv(api, ['manaclaude-oauth', 'manaclaude-api-OAUTH_KV']);
    expect(made).toMatchObject({ title: 'manaclaude-oauth', created: true });
    expect(state.kv).toHaveLength(4);
  });

  it('uploads the Teller certificate once per content and sends it as a non-CA certificate', async () => {
    const { api, state } = apiFor();
    const cert = '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n';
    const key = '-----BEGIN PRIVATE KEY-----\nBBB\n-----END PRIVATE KEY-----\n';
    const first = await ensureMtlsCertificate(api, cert, key);
    expect(first.created).toBe(true);
    expect(await ensureMtlsCertificate(api, cert + '\n', key)).toEqual({
      id: first.id,
      created: false,
    });
    const post = state.calls.find((c) => c.method === 'POST');
    expect(post?.body).toMatchObject({ name: certificateName(cert), ca: false });
    // a different certificate gets its own upload
    const other = await ensureMtlsCertificate(api, cert.replace('AAA', 'CCC'), key);
    expect(other.created).toBe(true);
    expect(state.certs).toHaveLength(2);
  });

  it('reads the workers.dev subdomain and registers one only when the account has none', async () => {
    const has = apiFor(newState({ subdomain: 'sankar' }));
    expect(await ensureWorkersSubdomain(has.api, 'x')).toEqual({
      subdomain: 'sankar',
      created: false,
    });
    expect(has.state.calls.some((c) => c.method === 'PUT')).toBe(false);

    const none = apiFor();
    const made = await ensureWorkersSubdomain(none.api, suggestSubdomain('acct123'));
    expect(made.created).toBe(true);
    expect(made.subdomain).toMatch(/^manaclaude-[0-9a-f]{8}$/);
    expect(suggestSubdomain('acct123')).toBe(suggestSubdomain('acct123'));
  });

  it('returns the Pages address, creating the project with main as production branch', async () => {
    const { api, state } = apiFor();
    expect(await ensurePagesProject(api, 'manaclaude')).toEqual({
      url: 'https://manaclaude.pages.dev',
      created: true,
    });
    expect(await ensurePagesProject(api, 'manaclaude')).toMatchObject({ created: false });
    expect(state.calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'manaclaude',
      production_branch: 'main',
    });
  });

  it('sends the token only as a bearer header and keeps it out of error messages', async () => {
    const { api, state } = apiFor();
    await ensureD1(api, 'manaclaude');
    expect(state.calls.every((c) => c.auth === 'Bearer tok_secret_value')).toBe(true);
    expect(state.calls.every((c) => !c.path.includes('tok_secret_value'))).toBe(true);
    const failing = new CloudflareApi(
      'tok_secret_value',
      'acct123',
      (async () =>
        new Response(
          '{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}',
          { status: 403 },
        )) as unknown as typeof fetch,
    );
    const err = await ensureD1(failing, 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudflareError);
    expect(String((err as Error).message)).toMatch(/Authentication error \[code 10000\]/);
    expect(String((err as Error).message)).not.toContain('tok_secret_value');
  });
});
