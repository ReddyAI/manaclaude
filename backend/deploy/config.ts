import { PLACEHOLDER_D1_ID, PLACEHOLDER_KV_ID } from './names.ts';

export interface DeployValues {
  databaseId: string;
  kvId: string;
  publicUrl: string;
}

function replaceOnce(text: string, find: string, replacement: string, what: string): string {
  const parts = text.split(find);
  if (parts.length !== 2) {
    throw new Error(
      `wrangler.toml should contain the ${what} placeholder exactly once (found ${parts.length - 1}).`,
    );
  }
  return parts.join(replacement);
}

/**
 * Fills the placeholders of backend/wrangler.toml with the real ids and the
 * Worker's public URL. The committed file never changes; the result is written
 * to wrangler.deploy.toml (git-ignored). Throws if a placeholder is missing, so
 * a change to wrangler.toml cannot silently deploy with fake ids.
 */
export function renderWranglerConfig(toml: string, v: DeployValues): string {
  let out = replaceOnce(toml, PLACEHOLDER_D1_ID, v.databaseId, 'D1 database id');
  out = replaceOnce(out, PLACEHOLDER_KV_ID, v.kvId, 'KV namespace id');
  const url = /^PUBLIC_URL = .*$/m;
  if (!url.test(out)) throw new Error('wrangler.toml has no PUBLIC_URL line.');
  return out.replace(url, `PUBLIC_URL = ${JSON.stringify(v.publicUrl)}`);
}

export function workerUrl(workerName: string, subdomain: string): string {
  return `https://${workerName}.${subdomain}.workers.dev`;
}

/** What goes into the run summary and the setup notes. */
export function summaryMarkdown(urls: {
  worker: string | null;
  web: string | null;
  mcp: string | null;
  notes?: string[];
}): string {
  const row = (label: string, url: string | null): string =>
    `| ${label} | ${url ?? 'not deployed'} |`;
  const lines = [
    '### Mana is deployed',
    '',
    '| What | URL |',
    '| --- | --- |',
    row('Worker (API)', urls.worker),
    row('Web app', urls.web),
    row('MCP server (Claude and Perplexity)', urls.mcp),
  ];
  if (urls.notes?.length) lines.push('', ...urls.notes.map((n) => `- ${n}`));
  return `${lines.join('\n')}\n`;
}

/** The GitHub secrets that are set (non-empty) among the names we copy. */
export function presentSecrets(
  names: readonly string[],
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = env[n];
    if (v !== undefined && v.trim() !== '') out[n] = v;
  }
  return out;
}
