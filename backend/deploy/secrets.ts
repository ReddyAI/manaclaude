import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { presentSecrets } from './config.ts';
import { WORKER_NAME, WORKER_SECRET_NAMES } from './names.ts';

type Env = Record<string, string | undefined>;

/** Secrets the app cannot do without; a missing one gets a warning, not a failure. */
export const IMPORTANT_SECRETS: Record<string, string> = {
  APP_API_TOKEN: 'the app cannot talk to the Worker without it',
  MCP_OWNER_PASSWORD: 'nobody can sign in to the MCP server from Claude or Perplexity without it',
  CREDENTIALS_SECRET: 'linked logins cannot be stored or synced without it',
};

export interface SecretsPlan {
  /** name -> value, only the ones that are set. */
  values: Record<string, string>;
  names: string[];
  warnings: string[];
}

export function planSecrets(env: Env): SecretsPlan {
  const values = presentSecrets(WORKER_SECRET_NAMES, env);
  const warnings = Object.entries(IMPORTANT_SECRETS)
    .filter(([name]) => !(name in values))
    .map(([name, why]) => `GitHub secret ${name} is not set: ${why}.`);
  return { values, names: Object.keys(values), warnings };
}

export type RunWrangler = (args: string[], cwd: string) => void;

const realWrangler: RunWrangler = (args, cwd) => {
  execFileSync('npx', ['wrangler', ...args], { cwd, stdio: 'inherit' });
};

/**
 * Copies each GitHub secret that exists into a Worker secret of the same name,
 * with one `wrangler secret bulk` call. The values travel through a private
 * temporary file (mode 0600, deleted straight after) and never through the
 * command line. A name with no GitHub secret is left alone: whatever the Worker
 * already holds stays.
 */
export function pushSecrets(
  env: Env,
  opts: { cwd: string; config: string; run?: RunWrangler; tempRoot?: string },
): SecretsPlan {
  const plan = planSecrets(env);
  for (const w of plan.warnings) console.log(`::warning::${w}`);
  if (plan.names.length === 0) {
    console.log('No Worker secrets to copy.');
    return plan;
  }
  const dir = mkdtempSync(join(opts.tempRoot ?? tmpdir(), 'mana-secrets-'));
  const file = join(dir, 'secrets.json');
  try {
    writeFileSync(file, JSON.stringify(plan.values), { mode: 0o600 });
    (opts.run ?? realWrangler)(
      ['secret', 'bulk', file, '--name', WORKER_NAME, '--config', opts.config],
      opts.cwd,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`Copied ${plan.names.length} Worker secrets: ${plan.names.join(', ')}`);
  return plan;
}

if (import.meta.main) {
  try {
    pushSecrets(process.env, {
      cwd: join(import.meta.dirname, '..'),
      config: 'wrangler.deploy.toml',
    });
  } catch (e) {
    console.error(
      `::error::Could not copy the Worker secrets: ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exit(1);
  }
}
