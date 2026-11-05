import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { presentSecrets, renderWranglerConfig, summaryMarkdown, workerUrl } from '../config.ts';
import { PLACEHOLDER_D1_ID, PLACEHOLDER_KV_ID, WORKER_SECRET_NAMES } from '../names.ts';

const toml = readFileSync(new URL('../../wrangler.toml', import.meta.url), 'utf8');
const values = {
  databaseId: 'db-1111',
  kvId: 'kv2222',
  publicUrl: 'https://manaclaude-api.me.workers.dev',
};

describe('renderWranglerConfig', () => {
  it('fills every placeholder of the real wrangler.toml', () => {
    const out = renderWranglerConfig(toml, values);
    expect(out).toContain('database_id = "db-1111"');
    expect(out).toContain('id = "kv2222"');
    expect(out).toContain('PUBLIC_URL = "https://manaclaude-api.me.workers.dev"');
    for (const p of [PLACEHOLDER_D1_ID, PLACEHOLDER_KV_ID]) {
      expect(out).not.toContain(p);
    }
    expect(out).toContain('[[d1_databases]]');
    expect(out).toContain('[[r2_buckets]]');
    expect(out).toContain('[ai]');
  });

  it('has no Teller certificate binding (Teller shut down its API in July 2026)', () => {
    const out = renderWranglerConfig(toml, values);
    expect(out).not.toContain('mtls_certificates');
    expect(out).not.toContain('TELLER_CERT');
  });

  it('fails loudly when a placeholder has gone missing', () => {
    expect(() => renderWranglerConfig(toml.replace(PLACEHOLDER_D1_ID, 'real'), values)).toThrow(
      /D1/,
    );
    expect(() => renderWranglerConfig(toml.replace(PLACEHOLDER_KV_ID, 'real'), values)).toThrow(
      /KV/,
    );
    expect(() => renderWranglerConfig(toml.replace(/^PUBLIC_URL = .*$/m, ''), values)).toThrow(
      /PUBLIC_URL/,
    );
    expect(() => renderWranglerConfig(toml + PLACEHOLDER_D1_ID, values)).toThrow(/exactly once/);
  });

  it('leaves the committed file with placeholders only (nothing real in a public repo)', () => {
    expect(toml).toContain(PLACEHOLDER_D1_ID);
    expect(toml).toContain(PLACEHOLDER_KV_ID);
  });
});

describe('small helpers', () => {
  it('builds the workers.dev address', () => {
    expect(workerUrl('manaclaude-api', 'me')).toBe('https://manaclaude-api.me.workers.dev');
  });

  it('keeps only secrets that are set and not blank', () => {
    expect(presentSecrets(['A', 'B', 'C'], { A: 'x', B: '', C: '  ', D: 'ignored' })).toEqual({
      A: 'x',
    });
  });

  it('writes the three addresses into the summary', () => {
    const md = summaryMarkdown({ worker: 'https://w', web: 'https://p', mcp: 'https://w/mcp' });
    expect(md).toContain('| Worker (API) | https://w |');
    expect(md).toContain('| Web app | https://p |');
    expect(md).toContain('| MCP server (Claude and Perplexity) | https://w/mcp |');
    expect(summaryMarkdown({ worker: null, web: null, mcp: null })).toContain('not deployed');
  });

  it('lists the 14 secrets (the 15 from session E1 without Teller), each once', () => {
    expect(new Set(WORKER_SECRET_NAMES).size).toBe(WORKER_SECRET_NAMES.length);
    expect(WORKER_SECRET_NAMES).toHaveLength(14);
    expect(WORKER_SECRET_NAMES).not.toContain('TELLER_APPLICATION_ID');
  });
});
