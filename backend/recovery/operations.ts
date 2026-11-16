import { createHmac } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { CloudflareApi } from '../deploy/cloudflare.ts';
import { renderWranglerConfig } from '../deploy/config.ts';
import { KV_TITLES } from '../deploy/names.ts';
import { backup, restoreLocal, verify } from './cli.ts';
import { inventory, type BucketEntry, type BucketSource } from './bucket.ts';
import { canonical, RecoveryError, sha256, MAX_FILE_BYTES } from './data.ts';
import { decryptBackup, encryptBackup, fileHash } from './encryption.ts';

const repo = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const worker = 'manaclaude-api';
const publicOutput = process.stdout.write.bind(process.stdout);
const publicError = process.stderr.write.bind(process.stderr);
function report(value: unknown) {
  publicOutput((typeof value === 'string' ? value : JSON.stringify(value)) + '\n');
}
export const operatorToken = (token: string, account: string) =>
  createHmac('sha256', token)
    .update('billionaire-recovery-v1:' + account)
    .digest('hex');
export interface Status {
  allowedRelease: string;
  protocol: number;
  on: boolean;
  active: number;
  drained: boolean;
  generation: number;
  release: string;
  proof?: string;
}
export class OperatorClient implements BucketSource {
  readonly origin: string;
  readonly token: string;
  readonly transport: typeof fetch;
  constructor(origin: string, token: string, transport: typeof fetch = fetch) {
    this.origin = origin;
    this.token = token;
    this.transport = transport;
    const url = new URL(origin);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
    )
      throw new RecoveryError('Invalid recovery origin.');
  }
  async request(path: string, body?: unknown) {
    const response = await this.transport(new URL('/__recovery/' + path, this.origin), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new RecoveryError('Recovery control request failed.');
    return response;
  }
  async status() {
    return (await (await this.request('status')).json()) as Status;
  }
  async maintenance(on: boolean) {
    const body = on ? { on } : { on, generation: (await this.status()).generation };
    return (await (await this.request('maintenance', body)).json()) as Status;
  }
  async drain(maxMs = 30 * 60_000, delayMs = 5_000) {
    const end = Date.now() + maxMs;
    for (;;) {
      const status = await this.status();
      if (!status.on || status.protocol !== 1)
        throw new RecoveryError('Maintenance hold is missing.');
      if (status.drained && status.active === 0) return status;
      if (Date.now() >= end) throw new RecoveryError('Drain timed out; maintenance remains on.');
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  async list() {
    const entries: BucketEntry[] = [],
      cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = (await (await this.request('objects', { cursor })).json()) as {
        objects: BucketEntry[];
        cursor: string | null;
      };
      entries.push(...page.objects);
      cursor = page.cursor;
      if (cursor && cursors.has(cursor)) throw new RecoveryError('Bucket pagination repeated.');
      if (cursor) cursors.add(cursor);
      if (cursors.size > 100_000) throw new RecoveryError('Bucket pagination limit exceeded.');
    } while (cursor);
    return inventory(entries);
  }
  async read(key: string) {
    const response = await this.request('object', { key });
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (!response.body) throw new RecoveryError('Missing object body.');
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > MAX_FILE_BYTES) {
        await response.body.cancel().catch(() => undefined);
        throw new RecoveryError('Object exceeds supported 20 MiB capture limit.');
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
}

export async function captureAndDrill(
  client: OperatorClient,
  sql: string,
  root: string,
  schemaMigrations?: string[],
  expectedHold?: Status,
) {
  const hold = await client.status();
  if (
    expectedHold &&
    (hold.generation !== expectedHold.generation || hold.release !== expectedHold.release)
  )
    throw new RecoveryError('Maintenance changed across D1 export; no verified backup.');
  if (hold.allowedRelease !== hold.release)
    throw new RecoveryError(
      'Maintenance release fence does not match the served Worker; complete the approved release before capture.',
    );
  if (!hold.drained || !hold.on || hold.active)
    throw new RecoveryError('Writers have not drained.');
  const before = await client.list();
  const result = await backup({
    sqlPath: sql,
    output: join(root, 'bundle'),
    writersStopped: true,
    bucket: client,
    schemaMigrations,
    readFile: async (ref) => {
      const object = before.find((o) => o.key === ref.key);
      if (!object) throw new RecoveryError('Referenced original is missing from R2.');
      return {
        bytes: await client.read(ref.key),
        contentType: object.httpMetadata.contentType ?? '',
      };
    },
  });
  await writeFile(join(root, 'capture.json'), JSON.stringify(result), { flag: 'wx', mode: 0o600 });
  const { image, manifest } = await verify(join(root, 'bundle'), result.manifestSha256);
  if (
    !manifest.bucket ||
    canonical(before) !== canonical(manifest.bucket.map(({ sha256: _sha, ...o }) => o)) ||
    canonical(before) !== canonical(await client.list())
  )
    throw new RecoveryError('Full R2 inventory does not equal the captured set.');
  const target = join(root, 'restore-drill');
  try {
    await restoreLocal(join(root, 'bundle'), result.manifestSha256, target);
  } finally {
    await rm(target, { recursive: true, force: true });
  }
  const after = await client.status();
  if (!after.drained || after.generation !== hold.generation || after.release !== hold.release)
    throw new RecoveryError('Maintenance generation or Worker changed during backup.');
  return { result, image, manifest, hold };
}

type QueryResult = { success: boolean; results: Record<string, unknown>[] };
export async function query(api: CloudflareApi, database: string, sql: string) {
  const response = await api.call<QueryResult[]>('POST', `/d1/database/${database}/query`, { sql });
  if (!response.result?.every((r) => r.success))
    throw new RecoveryError('Read-only D1 query failed.');
  return response.result.flatMap((r) => r.results);
}
async function existing(api: CloudflareApi) {
  const databases = await api.call<{ name: string; uuid: string }[]>(
    'GET',
    '/d1/database?per_page=100',
  );
  const database = databases.result?.find((d) => d.name === 'manaclaude')?.uuid;
  const sub = await api.call<{ subdomain: string }>('GET', '/workers/subdomain');
  if (!database || !sub.result?.subdomain)
    throw new RecoveryError('Existing production resources were not found.');
  return { database, origin: `https://${worker}.${sub.result.subdomain}.workers.dev` };
}
async function assertMain() {
  if (
    process.env.GITHUB_REF !== 'refs/heads/main' ||
    process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
  )
    throw new RecoveryError('Use the manual workflow on main.');
  const response = await fetch(
    `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/git/ref/heads/main`,
    {
      headers: {
        authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        accept: 'application/vnd.github+json',
      },
      redirect: 'error',
    },
  );
  if (
    !response.ok ||
    ((await response.json()) as { object: { sha: string } }).object.sha !== process.env.GITHUB_SHA
  )
    throw new RecoveryError('Workflow main changed; run the current main workflow.');
}
async function protection(requireReview = true) {
  const response = await fetch(
    `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/environments/production-migrations`,
    {
      headers: {
        authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        accept: 'application/vnd.github+json',
      },
      redirect: 'error',
    },
  );
  const data = (await response.json()) as {
    protection_rules?: { type: string; reviewers?: { reviewer: { login?: string } }[] }[];
  };
  if (
    !response.ok ||
    !data.protection_rules?.some(
      (p) =>
        p.type === 'required_reviewers' && p.reviewers?.some((r) => r.reviewer.login === 'ReddyAI'),
    )
  )
    throw new RecoveryError(
      'Configure Sankar as required reviewer on production-migrations first.',
    );
  if (!requireReview) return;
  const reviews = await fetch(
    `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}/approvals`,
    {
      headers: {
        authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        accept: 'application/vnd.github+json',
      },
      redirect: 'error',
    },
  );
  const history = (await reviews.json()) as {
    state: string;
    user: { login: string };
    environments: { name: string }[];
  }[];
  if (
    !reviews.ok ||
    !history.some(
      (r) =>
        r.state === 'approved' &&
        r.user.login === 'ReddyAI' &&
        r.environments.some((e) => e.name === 'production-migrations'),
    )
  )
    throw new RecoveryError('This pinned release has no recorded Sankar approval.');
}
async function privateCommand(root: string, command: string, args: string[], cwd = repo) {
  // Tools may print SQL, signed URLs or filenames: neither stdout nor stderr reaches Actions.
  const { open } = await import('node:fs/promises');
  const log = await open(join(root, 'command.private'), 'a', 0o600);
  try {
    await new Promise<void>((yes, no) => {
      const child = spawn(command, args, {
        cwd,
        stdio: ['ignore', log.fd, log.fd],
        env: process.env,
      });
      child.on('error', () => no(new RecoveryError('Private command could not start.')));
      child.on('close', (code) =>
        code === 0 ? yes() : no(new RecoveryError('Private command failed.')),
      );
    });
  } finally {
    await log.close();
  }
}
async function configure(
  api: CloudflareApi,
  root: string,
  values: Awaited<ReturnType<typeof existing>>,
) {
  const namespaces = await api.call<{ id: string; title: string }[]>(
    'GET',
    '/storage/kv/namespaces?per_page=100',
  );
  const kv = namespaces.result?.find((n) => (KV_TITLES as readonly string[]).includes(n.title));
  if (!kv) throw new RecoveryError('Existing OAuth namespace not found.');
  const source = await readFile(join(repo, 'backend/wrangler.toml'), 'utf8');
  const config = renderWranglerConfig(source, {
    databaseId: values.database,
    kvId: kv.id,
    publicUrl: values.origin,
  }).replace('[vars]', `[vars]\nRELEASE_COMMIT = "${process.env.GITHUB_SHA}"`);
  await writeFile(join(repo, 'backend/wrangler.deploy.toml'), config, { mode: 0o600 });
  await writeFile(join(root, 'database.json'), JSON.stringify(values), { mode: 0o600 });
}
async function activeRelease(
  api: CloudflareApi,
  client: OperatorClient,
  expected: string,
  database: string,
) {
  const domains = await api.call<{ enabled: boolean; previews_enabled: boolean }>(
    'GET',
    `/workers/scripts/${worker}/subdomain`,
  );
  if (!domains.result?.enabled || domains.result.previews_enabled !== false)
    throw new RecoveryError(
      'Production origin must be enabled with old version preview URLs disabled.',
    );
  const status = await client.status();
  const deployment = await api.call<{ versions: { version_id: string; percentage: number }[] }[]>(
    'GET',
    `/workers/scripts/${worker}/deployments`,
  );
  // API returns { deployments: [...] } on current Workers API.
  const data = deployment.result as unknown as {
    deployments?: { versions: { version_id: string; percentage: number }[] }[];
  };
  const versions = (Array.isArray(deployment.result) ? deployment.result : data?.deployments)?.[0]
    ?.versions;
  if (
    !versions ||
    versions.length !== 1 ||
    versions[0]?.percentage !== 100 ||
    status.release !== expected
  )
    throw new RecoveryError(
      'Active Worker release or traffic allocation is not the pinned main release.',
    );
  const version = await api.call<{
    resources?: {
      bindings?: {
        name: string;
        text?: string;
        id?: string;
        database_id?: string;
        bucket_name?: string;
      }[];
    };
  }>('GET', `/workers/scripts/${worker}/versions/${versions[0].version_id}`);
  if (
    !version.result?.resources?.bindings?.some(
      (b) => b.name === 'RELEASE_COMMIT' && b.text === expected,
    )
  )
    throw new RecoveryError('Active version lacks matching main provenance.');
  if (version.result.resources.bindings.some((b) => b.name === 'MAINTENANCE_TEST_DEFAULT'))
    throw new RecoveryError('Test-only maintenance defaults must not be present in production.');
  const bindings = version.result.resources.bindings;
  if (!bindings.some((b) => b.name === 'PUBLIC_URL' && b.text === client.origin.replace(/\/$/, '')))
    throw new RecoveryError('Worker PUBLIC_URL does not match the verified production origin.');
  if (
    !bindings.some((b) => b.name === 'DB' && (b.id ?? b.database_id) === database) ||
    !bindings.some((b) => b.name === 'FILES' && b.bucket_name === 'manaclaude-files')
  )
    throw new RecoveryError('Worker D1/R2 bindings do not match the production capture targets.');
  return status;
}

export async function rolloutChecks(
  api: CloudflareApi,
  database: string,
  client: OperatorClient,
  expected: string,
  captured: Awaited<ReturnType<typeof captureAndDrill>>,
  emit: (value: unknown) => void = report,
) {
  phase = '3a: applied migration journal and pinned main Worker provenance';
  const names =
    captured.manifest.schemaMigrations ??
    (await readdir(join(repo, 'backend/migrations'))).filter((n) => n.endsWith('.sql')).sort();
  const recorded = (await query(api, database, 'SELECT name FROM d1_migrations ORDER BY name')).map(
    (r) => r.name,
  );
  if (canonical(recorded) !== canonical(names))
    throw new RecoveryError('3a failed: migration journal mismatch.');
  await activeRelease(api, client, expected, database);
  emit('3a passed');
  phase = '3b: exact trigger definitions and revision singletons';
  const triggers = (
    await query(api, database, "SELECT sql FROM sqlite_schema WHERE type='trigger' ORDER BY name")
  ).map((r) => r.sql);
  if (canonical(triggers) !== canonical(captured.image.triggers))
    throw new RecoveryError('3b failed: exact triggers differ.');
  for (const table of ['history_revision', 'investment_revision']) {
    const rows = await query(api, database, `SELECT id, revision FROM ${table}`);
    if (
      rows.length !== 1 ||
      rows[0]?.id !== 1 ||
      !/^[a-f0-9]{64}$/.test(String(rows[0]?.revision)) ||
      canonical(rows) !== canonical(captured.image.tables.find((t) => t.name === table)?.rows)
    )
      throw new RecoveryError('3b failed: revision singleton mismatch.');
  }
  emit('3b passed');
  phase = '3d: untouched policy, review and archive counts';
  for (const table of ['history_policy', 'history_bank_reviews', 'investment_archive']) {
    const rows = await query(api, database, `SELECT count(*) AS count FROM ${table}`);
    emit({ [table + 'Rows']: rows[0]?.count });
    if (rows[0]?.count !== 0)
      throw new RecoveryError(
        '3d failed: expected untouched policy/review/archive state differs; review provenance before repair.',
      );
  }
  emit('3d passed');
}

async function outputs(values: Record<string, string>) {
  if (process.env.GITHUB_OUTPUT)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      Object.entries(values)
        .map(([k, v]) => `${k}=${v}\n`)
        .join(''),
    );
}
let phase = 'preflight';
export async function run(action: string) {
  process.umask(0o077);
  if (action === 'cleanup') {
    const root = process.env.RECOVERY_PRIVATE_ROOT;
    if (
      root &&
      resolve(root).startsWith(
        resolve(process.env.RUNNER_TEMP ?? tmpdir()) + '/billionaire-recovery-',
      )
    )
      await rm(root, { recursive: true, force: true });
    return;
  }
  if (action === 'restore') {
    phase = 'decrypt';
    const input = process.env.RECOVERY_INPUT;
    if (!input || !process.env.BACKUP_PASSPHRASE)
      throw new RecoveryError('Encrypted backup and passphrase are required.');
    const parent = await mkdtemp(
      join(process.env.RUNNER_TEMP ?? tmpdir(), 'billionaire-recovery-'),
    );
    await outputs({ private_root: parent });
    try {
      const root = await decryptBackup(
        input,
        join(parent, 'decrypted'),
        process.env.BACKUP_PASSPHRASE,
      );
      const capture = JSON.parse(await readFile(join(root, 'capture.json'), 'utf8')) as {
        manifestSha256: string;
      };
      phase = 'verify';
      const { manifest, image } = await verify(join(root, 'bundle'), capture.manifestSha256);
      if (!manifest.bucket) throw new RecoveryError('A whole-bucket backup is required.');
      phase = 'restore-local';
      await restoreLocal(join(root, 'bundle'), capture.manifestSha256, join(root, 'restore-drill'));
      report(
        JSON.stringify({
          tables: manifest.tables.length,
          r2Objects: manifest.bucket.length,
          manifestSha256: capture.manifestSha256,
          databaseSha256: manifest.database.sha256,
          triggers: image.triggers.length,
          encryptedSha256: await fileHash(input),
        }),
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
    report('Restore drill passed; disposable copy deleted.');
    return;
  }
  await assertMain();
  const token = process.env.CLOUDFLARE_API_TOKEN,
    account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account)
    throw new RecoveryError('Existing Cloudflare Actions secrets are required.');
  const api = new CloudflareApi(token, account);
  const values = await existing(api);
  const client = new OperatorClient(values.origin, operatorToken(token, account));
  if (action === 'off' || action === 'release-resume') {
    if (action === 'release-resume') {
      phase = 'post-deployment provenance and schema';
      await activeRelease(api, client, process.env.GITHUB_SHA!, values.database);
      const names = (await readdir(join(repo, 'backend/migrations')))
        .filter((n) => n.endsWith('.sql'))
        .sort();
      if (
        canonical(
          (await query(api, values.database, 'SELECT name FROM d1_migrations ORDER BY name')).map(
            (r) => r.name,
          ),
        ) !== canonical(names)
      )
        throw new RecoveryError('Post-deployment migration journal differs.');
      const { DatabaseSync } = await import('node:sqlite');
      const expected = new DatabaseSync(':memory:');
      try {
        for (const name of names)
          expected.exec(await readFile(join(repo, 'backend/migrations', name), 'utf8'));
        if (
          canonical(
            expected
              .prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name")
              .all(),
          ) !==
          canonical(
            await query(
              api,
              values.database,
              "SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name",
            ),
          )
        )
          throw new RecoveryError('Post-deployment triggers differ.');
      } finally {
        expected.close();
      }
      for (const table of ['history_revision', 'investment_revision']) {
        const rows = await query(api, values.database, `SELECT id,revision FROM ${table}`);
        if (
          rows.length !== 1 ||
          rows[0]?.id !== 1 ||
          !/^[a-f0-9]{64}$/.test(String(rows[0]?.revision))
        )
          throw new RecoveryError('Post-deployment revision invalid.');
      }
      phase = 'fence old Worker versions before resume';
      await client.request('activate', {
        release: process.env.GITHUB_SHA!,
        generation: (await client.status()).generation,
      });
    }
    phase = 'resume';
    const state = await client.maintenance(false);
    if (state.on) throw new RecoveryError('Maintenance did not turn off.');
    report('Maintenance off');
    return;
  }
  if (action === 'status') {
    const s = await client.status();
    report(
      JSON.stringify({
        maintenance: Number(s.on),
        activeWriters: s.active,
        drained: Number(s.drained),
      }),
    );
    return;
  }
  if (action === 'on') {
    phase = 'maintenance on';
    await client.maintenance(true);
    phase = 'drain';
    const state = await client.drain();
    report(JSON.stringify({ maintenance: 1, activeWriters: state.active, drained: 1 }));
    return;
  }
  if (action === 'pre-migration') {
    phase = 'unexpired encrypted backup artifact';
    const response = await fetch(
      `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}/artifacts?per_page=100`,
      {
        headers: {
          authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          accept: 'application/vnd.github+json',
        },
        redirect: 'error',
      },
    );
    const artifacts = (await response.json()) as {
      artifacts: { name: string; expired: boolean; size_in_bytes: number }[];
    };
    if (
      !response.ok ||
      !artifacts.artifacts?.some(
        (a) => a.name === 'billionaire-backup-encrypted' && !a.expired && a.size_in_bytes > 0,
      )
    )
      throw new RecoveryError(
        'The encrypted backup artifact is missing or expired; do not apply migrations.',
      );
    const s = await client.status();
    if (!s.drained || !s.on || !s.proof || s.proof !== process.env.RECOVERY_PROOF)
      throw new RecoveryError('Verified backup proof for this maintenance hold is missing.');
    report('Verified backup and drained maintenance hold passed');
    return;
  }
  const root = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), 'billionaire-recovery-'));
  await outputs({ private_root: root });
  process.env.TMPDIR = join(root, 'tmp');
  process.env.XDG_CONFIG_HOME = join(root, 'config');
  process.env.WRANGLER_LOG_PATH = join(root, 'wrangler-logs/');
  process.env.WRANGLER_SEND_METRICS = 'false';
  await mkdir(process.env.TMPDIR);
  await mkdir(process.env.XDG_CONFIG_HOME);
  if (action === 'configure-release') {
    phase = 'protected migration approval';
    await protection();
    await configure(api, root, values);
    return;
  }
  if (action === 'prepare-release' || action === 'bootstrap') {
    phase = 'required approval protection';
    await protection(action === 'bootstrap');
    if (!process.env.BACKUP_PASSPHRASE || Buffer.byteLength(process.env.BACKUP_PASSPHRASE) < 20)
      throw new RecoveryError('Set BACKUP_PASSPHRASE first.');
    const settings = await api.call<{ bindings: { name: string }[] }>(
      'GET',
      `/workers/scripts/${worker}/settings`,
    );
    if (!Array.isArray(settings.result?.bindings))
      throw new RecoveryError('Worker binding metadata is unavailable.');
    const firstInstall = !settings.result.bindings.some((b) => b.name === 'MAINTENANCE');
    if (firstInstall && (action !== 'bootstrap' || process.env.INSTALL_MAINTENANCE !== 'true'))
      throw new RecoveryError(
        'The missing gate requires the explicit first-install choice and protected approval.',
      );
    if (!firstInstall && action === 'bootstrap')
      throw new RecoveryError(
        'Maintenance is already installed; leave the first-install choice off.',
      );
    if (firstInstall) {
      phase = 'first installation schema gate';
      const journal = (
        await query(api, values.database, 'SELECT name FROM d1_migrations ORDER BY name')
      ).map((r) => r.name);
      const names = (await readdir(join(repo, 'backend/migrations')))
        .filter((n) => n.endsWith('.sql'))
        .sort();
      if (canonical(journal) !== canonical(names))
        throw new RecoveryError(
          'First maintenance installation requires no pending D1 migrations.',
        );
    }
    await configure(api, root, values);
    phase = 'operator authentication';
    await api.call('PUT', `/workers/scripts/${worker}/secrets`, {
      name: 'RECOVERY_OPERATOR_TOKEN',
      type: 'secret_text',
      text: client.token,
    });
    if (firstInstall) {
      phase = 'install closed maintenance gate';
      await privateCommand(
        root,
        process.execPath,
        [
          join(repo, 'node_modules/wrangler/bin/wrangler.js'),
          'deploy',
          '--config',
          'wrangler.deploy.toml',
          '--tag',
          process.env.GITHUB_SHA!,
        ],
        join(repo, 'backend'),
      );
    }
    phase = 'confirm maintenance control installation';
    let installed = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        installed = (await client.status()).protocol === 1;
      } catch {
        /* Secret/deployment propagation only; never redeploy as a fallback. */
      }
      if (installed) break;
      await new Promise((r) => setTimeout(r, 5_000));
    }
    if (!installed)
      throw new RecoveryError(
        'Maintenance control could not be confirmed; no migration is permitted.',
      );
    await client.maintenance(true);
    await outputs({
      ready: 'true',
      worker_url: values.origin,
      mcp_url: values.origin + '/mcp',
      web_url:
        'https://' +
        (await api.call<{ subdomain: string }>('GET', '/pages/projects/manaclaude')).result!
          .subdomain,
    });
    report('Release preparation passed; maintenance is on.');
    return;
  }
  if (action !== 'backup' && action !== 'release-backup')
    throw new RecoveryError('Unknown recovery operation.');
  if (!process.env.BACKUP_PASSPHRASE || Buffer.byteLength(process.env.BACKUP_PASSPHRASE) < 20)
    throw new RecoveryError('Set BACKUP_PASSPHRASE first.');
  phase = 'maintenance on';
  await client.maintenance(true);
  phase = 'drain';
  const sourceHold = await client.drain();
  phase = 'source release provenance';
  const expected =
    action === 'release-backup' ? (await client.status()).release : process.env.GITHUB_SHA!;
  if (!/^[a-f0-9]{40}$/.test(expected))
    throw new RecoveryError('Production release provenance is missing.');
  await activeRelease(api, client, expected, values.database);
  if (expected !== process.env.GITHUB_SHA) {
    const compared = await fetch(
      `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/compare/${expected}...${process.env.GITHUB_SHA}`,
      {
        headers: {
          authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          accept: 'application/vnd.github+json',
        },
        redirect: 'error',
      },
    );
    if (
      !compared.ok ||
      !['ahead', 'identical'].includes(((await compared.json()) as { status: string }).status)
    )
      throw new RecoveryError('Deployed source is not an ancestor of the approved main release.');
  }
  phase = 'export';
  const config = join(root, 'd1.json');
  await writeFile(
    config,
    JSON.stringify({
      name: worker,
      compatibility_date: '2026-10-15',
      d1_databases: [{ binding: 'DB', database_name: 'manaclaude', database_id: values.database }],
    }),
    { mode: 0o600 },
  );
  const sql = join(root, 'source.sql');
  await privateCommand(root, process.execPath, [
    join(repo, 'node_modules/wrangler/bin/wrangler.js'),
    'd1',
    'export',
    'manaclaude',
    '--remote',
    '--skip-confirmation',
    '--config',
    config,
    '--output',
    sql,
  ]);
  phase = 'capture verify restore-local inventory';
  const schemaMigrations = (
    await query(api, values.database, 'SELECT name FROM d1_migrations ORDER BY name')
  ).map((r) => String(r.name));
  const captured = await captureAndDrill(client, sql, root, schemaMigrations, sourceHold);
  phase = 'encrypt';
  const encrypted = join(root, 'backup.enc');
  const summary = await encryptBackup(root, encrypted, process.env.BACKUP_PASSPHRASE);
  await outputs({
    encrypted: 'true',
    encrypted_file: encrypted,
    proof: captured.result.manifestSha256,
  });
  report(
    JSON.stringify({
      ...summary,
      tables: captured.manifest.tables,
      r2Objects: captured.manifest.bucket!.length,
      originalBytes: captured.manifest.bucket!.reduce((n, o) => n + o.bytes, 0),
      manifestSha256: captured.result.manifestSha256,
      databaseBytes: captured.manifest.database.bytes,
      databaseSha256: captured.manifest.database.sha256,
      triggers: captured.image.triggers.length,
      triggersSha256: sha256(canonical(captured.image.triggers)),
    }),
  );
  report('Backup verified; restore drill passed; whole R2 inventory matched.');
  report(
    '3c: Complete retained versioned logs with write/row IDs can establish past write impact; missing, sampled or expired logs and a new tail cannot rule it out. Historical impact is not certified by this backup.',
  );
  phase = 'rollout checks';
  // During a release, the current deployed main can precede this approved release.
  await rolloutChecks(api, values.database, client, expected, captured);
  phase = 'record verified proof';
  await client.request('proof', {
    proof: captured.result.manifestSha256,
    generation: captured.hold.generation,
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const diagnostics = await mkdtemp(
    join(process.env.RUNNER_TEMP ?? tmpdir(), 'billionaire-recovery-'),
  );
  const stdout = process.stdout.write,
    stderr = process.stderr.write;
  const quiet = ((
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | (() => void),
    callback?: () => void,
  ) => {
    appendFileSync(
      join(diagnostics, 'library.private'),
      typeof chunk === 'string'
        ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8')
        : chunk,
    );
    if (typeof encoding === 'function') encoding();
    else callback?.();
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = quiet;
  process.stderr.write = quiet;
  run(process.argv[2] ?? '')
    .catch((error: unknown) => {
      // NEVER print an exception: provider/SQL/archive errors can contain private data.
      const reason =
        error instanceof RecoveryError
          ? error.message
          : 'The operation did not complete; private diagnostic details were not published.';
      publicError(
        `::error::Recovery failed during ${phase}. ${reason} Maintenance is not automatically resumed. Use Maintenance status; do not assume writers are enabled or drained.\n`,
      );
      process.exitCode = 1;
    })
    .finally(async () => {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
      await rm(diagnostics, { recursive: true, force: true });
    });
}
