import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CloudflareApi } from '../cloudflare.ts';
import { prepare, writeGithubOutputs } from '../prepare.ts';
import { fakeCloudflare, newState } from './fakeCloudflare.ts';

const CERT = '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----';
const KEY = '-----BEGIN PRIVATE KEY-----\nBBB\n-----END PRIVATE KEY-----';

const run = (state = newState(), env: Record<string, string | undefined> = {}) =>
  prepare(new CloudflareApi('t', 'acct123', fakeCloudflare(state)), env, () => undefined);

describe('prepare', () => {
  it('creates everything on a fresh account and works out the URLs', async () => {
    const state = newState();
    const r = await run(state, { TELLER_CERT_PEM: CERT, TELLER_KEY_PEM: KEY });
    expect(state.d1.map((d) => d.name)).toEqual(['manaclaude']);
    expect(state.r2).toEqual(['manaclaude-files']);
    expect(state.kv.map((k) => k.title)).toEqual(['manaclaude-oauth']);
    expect(state.certs).toHaveLength(1);
    expect(state.pages.map((p) => p.name)).toEqual(['manaclaude']);
    expect(r.certificateId).toBe(state.certs[0]?.id);
    expect(r.workerUrl).toBe(`https://manaclaude-api.${state.subdomain}.workers.dev`);
    expect(r.mcpUrl).toBe(`${r.workerUrl}/mcp`);
    expect(r.webUrl).toBe('https://manaclaude.pages.dev');
    expect(r.notes.join(' ')).toMatch(/registered/);
  });

  it('changes nothing on a second run and keeps the same ids and URLs', async () => {
    const state = newState();
    const first = await run(state, { TELLER_CERT_PEM: CERT, TELLER_KEY_PEM: KEY });
    const writes = () => state.calls.filter((c) => c.method !== 'GET').length;
    const before = writes();
    const second = await run(state, { TELLER_CERT_PEM: CERT, TELLER_KEY_PEM: KEY });
    expect(writes()).toBe(before);
    expect(second).toEqual({ ...first, notes: [] });
  });

  it('skips the Teller certificate unless both PEM secrets are set', async () => {
    for (const env of [
      {},
      { TELLER_CERT_PEM: CERT },
      { TELLER_KEY_PEM: KEY },
      { TELLER_CERT_PEM: ' ', TELLER_KEY_PEM: KEY },
    ]) {
      const state = newState();
      const r = await run(state, env);
      expect(r.certificateId).toBeNull();
      expect(state.certs).toHaveLength(0);
      expect(r.notes.join(' ')).toMatch(/Teller is deployed without its certificate/);
    }
  });

  it('stops with a plain message when R2 is off', async () => {
    await expect(run(newState({ r2Enabled: false }))).rejects.toThrow(/R2 is not turned on/);
  });

  it('writes single-line GitHub outputs and refuses multi-line values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mana-out-'));
    try {
      const file = join(dir, 'out');
      writeGithubOutputs(file, { a: '1', b: 'https://x' });
      expect(readFileSync(file, 'utf8')).toBe('a=1\nb=https://x\n');
      expect(() => writeGithubOutputs(file, { c: 'one\ntwo' })).toThrow();
      expect(() => writeGithubOutputs(undefined, { a: '1' })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
