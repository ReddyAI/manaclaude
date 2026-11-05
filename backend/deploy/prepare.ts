import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CloudflareApi,
  ensureD1,
  ensureKv,
  ensureMtlsCertificate,
  ensurePagesProject,
  ensureR2,
  ensureWorkersSubdomain,
  suggestSubdomain,
} from './cloudflare.ts';
import { renderWranglerConfig, workerUrl } from './config.ts';
import { D1_NAME, KV_TITLES, PAGES_PROJECT, R2_BUCKET, WORKER_NAME } from './names.ts';

export interface PrepareResult {
  databaseId: string;
  kvId: string;
  certificateId: string | null;
  subdomain: string;
  workerUrl: string;
  mcpUrl: string;
  webUrl: string;
  notes: string[];
}

type Env = Record<string, string | undefined>;

/**
 * Creates or reuses everything the Worker and the web app need in the
 * Cloudflare account, looked up by name so a re-run changes nothing:
 * the D1 database, the R2 bucket, the OAuth KV namespace, the Teller mTLS
 * certificate (only when TELLER_CERT_PEM and TELLER_KEY_PEM are set), the
 * workers.dev subdomain (which gives the Worker's public URL before it is
 * deployed) and the Pages project (which gives the web app's URL).
 */
export async function prepare(
  api: CloudflareApi,
  env: Env,
  log: (line: string) => void = console.log,
): Promise<PrepareResult> {
  const notes: string[] = [];

  const d1 = await ensureD1(api, D1_NAME);
  log(`D1 database "${D1_NAME}": ${d1.created ? 'created' : 'found'}`);

  const r2 = await ensureR2(api, R2_BUCKET);
  log(`R2 bucket "${R2_BUCKET}": ${r2.created ? 'created' : 'found'}`);

  const kv = await ensureKv(api, KV_TITLES);
  log(`KV namespace "${kv.title}": ${kv.created ? 'created' : 'found'}`);

  let certificateId: string | null = null;
  const certPem = env.TELLER_CERT_PEM?.trim();
  const keyPem = env.TELLER_KEY_PEM?.trim();
  if (certPem && keyPem) {
    const cert = await ensureMtlsCertificate(api, certPem, keyPem);
    certificateId = cert.id;
    log(`Teller certificate: ${cert.created ? 'uploaded' : 'already uploaded'}`);
  } else {
    log('Teller certificate: skipped (TELLER_CERT_PEM and TELLER_KEY_PEM are not both set)');
    notes.push(
      'Teller is deployed without its certificate. Add TELLER_CERT_PEM and TELLER_KEY_PEM and re-run to use Teller outside its sandbox.',
    );
  }

  const sub = await ensureWorkersSubdomain(api, suggestSubdomain(api.accountId));
  if (sub.created) {
    notes.push(
      `This account had no workers.dev address, so "${sub.subdomain}" was registered. Use it in the Zerodha redirect URL.`,
    );
  }
  log(`workers.dev subdomain: ${sub.created ? 'registered' : 'found'}`);

  const pages = await ensurePagesProject(api, PAGES_PROJECT);
  log(`Pages project "${PAGES_PROJECT}": ${pages.created ? 'created' : 'found'}`);

  const url = workerUrl(WORKER_NAME, sub.subdomain);
  return {
    databaseId: d1.id,
    kvId: kv.id,
    certificateId,
    subdomain: sub.subdomain,
    workerUrl: url,
    mcpUrl: `${url}/mcp`,
    webUrl: pages.url,
    notes,
  };
}

/** Appends name=value lines to the file GitHub Actions gives a step for its outputs. */
export function writeGithubOutputs(file: string | undefined, values: Record<string, string>): void {
  if (!file) return;
  const lines = Object.entries(values).map(([k, v]) => {
    if (/[\r\n]/.test(v)) throw new Error(`Output ${k} must be a single line.`);
    return `${k}=${v}`;
  });
  appendFileSync(file, `${lines.join('\n')}\n`);
}

async function main(): Promise<void> {
  const env = process.env;
  const token = env.CLOUDFLARE_API_TOKEN;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is not set.');
  if (!accountId) throw new Error('CLOUDFLARE_ACCOUNT_ID is not set.');
  const result = await prepare(new CloudflareApi(token, accountId), env);

  const source = fileURLToPath(new URL('../wrangler.toml', import.meta.url));
  const target = fileURLToPath(new URL('../wrangler.deploy.toml', import.meta.url));
  writeFileSync(
    target,
    renderWranglerConfig(readFileSync(source, 'utf8'), {
      databaseId: result.databaseId,
      kvId: result.kvId,
      certificateId: result.certificateId,
      publicUrl: result.workerUrl,
    }),
  );
  console.log(`Wrote backend/wrangler.deploy.toml (Worker URL ${result.workerUrl})`);

  writeGithubOutputs(env.GITHUB_OUTPUT, {
    worker_url: result.workerUrl,
    mcp_url: result.mcpUrl,
    web_url: result.webUrl,
    subdomain: result.subdomain,
    teller_cert: result.certificateId ? 'true' : 'false',
  });
  if (env.GITHUB_STEP_SUMMARY && result.notes.length > 0) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${result.notes.map((n) => `- ${n}`).join('\n')}\n`);
  }
  for (const note of result.notes) console.log(`::notice::${note}`);
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(`::error::${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
