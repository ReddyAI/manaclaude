import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WORKER_SECRET_NAMES } from '../names.ts';
import { writeSummary } from '../summary.ts';

const root = new URL('../../../', import.meta.url);
const deploy = readFileSync(new URL('.github/workflows/deploy-worker.yml', root), 'utf8');
const web = readFileSync(new URL('.github/workflows/web.yml', root), 'utf8');

/** The text of one step: from its "- name:" line to the next step. */
function step(yaml: string, name: string): string {
  const start = yaml.indexOf(`- name: ${name}`);
  expect(start, `step "${name}" exists`).toBeGreaterThan(-1);
  const rest = yaml.slice(start + 1);
  const next = rest.search(/\n {6}- /);
  return rest.slice(0, next === -1 ? undefined : next);
}

describe('deploy workflow', () => {
  it('runs on every push to main and by hand', () => {
    expect(deploy).toMatch(/on:\n {2}push:\n {4}branches: \[main\]\n {2}workflow_dispatch:/);
  });

  it('needs only the two Cloudflare secrets and skips cleanly without the token', () => {
    const gate = step(deploy, 'Check for the Cloudflare secrets');
    expect(gate).toContain('ready=false');
    expect(gate).toContain('skipping the Cloudflare deploy');
    expect(gate).not.toMatch(/exit 1[^]*ready=false/); // the skip path does not fail
    expect(deploy).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');
    expect(deploy).toContain('CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}');
  });

  it('copies exactly the listed secrets, by the same name, through env only', () => {
    const copy = step(deploy, 'Copy secrets into the Worker');
    const mapped = [...copy.matchAll(/^ {10}([A-Z0-9_]+): \$\{\{ secrets\.([A-Z0-9_]+) \}\}$/gm)];
    expect(mapped.map((m) => m[1]).sort()).toEqual([...WORKER_SECRET_NAMES].sort());
    for (const m of mapped) expect(m[2]).toBe(m[1]);
  });

  it('never puts a secret on a command line or in a run block', () => {
    for (const run of deploy.matchAll(/run: ([^\n]*(?:\n {10}[^\n]*)*)/g)) {
      expect(run[1]).not.toMatch(/\$\{\{\s*secrets\./);
    }
  });

  it('prepares resources before migrating, migrates before deploying, copies secrets after deploying', () => {
    const order = [
      'Create or reuse Cloudflare resources',
      'Apply D1 migrations',
      'Deploy the Worker',
      'Copy secrets into the Worker',
    ].map((n) => deploy.indexOf(`- name: ${n}`));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('prepares resources without any Teller certificate (Teller shut down its API in July 2026)', () => {
    const prep = step(deploy, 'Create or reuse Cloudflare resources');
    expect(prep).toContain('node backend/deploy/prepare.ts');
    expect(deploy).not.toContain('TELLER_');
  });

  it('deploys with the generated config, so the committed file keeps its placeholders', () => {
    expect(step(deploy, 'Apply D1 migrations')).toContain('--config wrangler.deploy.toml');
    expect(step(deploy, 'Deploy the Worker')).toContain('--config wrangler.deploy.toml');
    expect(deploy).not.toMatch(/sed -i/);
    expect(deploy).not.toContain('vars.PUBLIC_URL');
  });

  it('deploys the web app to Pages with the same two secrets and prints three URLs', () => {
    expect(deploy).toContain('wrangler pages deploy apps/mobile/dist --project-name manaclaude');
    expect(deploy).toContain('node backend/deploy/summary.ts');
    for (const k of ['WORKER_URL', 'WEB_URL', 'MCP_URL']) expect(deploy).toContain(`${k}:`);
  });

  it('keeps the API token out of the web build', () => {
    const build = step(deploy, 'Export the web build');
    expect(build).toContain('EXPO_PUBLIC_API_URL');
    expect(build).not.toMatch(/APP_API_TOKEN/);
  });

  it('leaves the web build workflow building the artifact', () => {
    expect(web).toContain('npx expo export --platform web');
    expect(web).toContain('upload-artifact');
  });
});

describe('run summary', () => {
  it('lists the Worker, web app and MCP URLs and the Zerodha redirect URL', () => {
    const md = writeSummary({
      WORKER_URL: 'https://manaclaude-api.me.workers.dev',
      WEB_URL: 'https://manaclaude.pages.dev',
      MCP_URL: 'https://manaclaude-api.me.workers.dev/mcp',
      WEB_DEPLOYED: 'true',
    });
    expect(md).toContain('https://manaclaude-api.me.workers.dev |');
    expect(md).toContain('https://manaclaude.pages.dev |');
    expect(md).toContain('https://manaclaude-api.me.workers.dev/mcp |');
    expect(md).toContain('https://manaclaude-api.me.workers.dev/v1/link/zerodha_kite/callback');
  });
});
