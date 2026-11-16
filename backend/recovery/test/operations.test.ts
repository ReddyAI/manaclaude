import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, access, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { getPlatformProxy } from 'wrangler';
import { readD1Migrations } from '@cloudflare/vitest-plugin';
import { captureAndDrill, OperatorClient, operatorToken, rolloutChecks } from '../operations.ts';
import { canonical, sha256 } from '../data.ts';
import { decryptBackup, encryptBackup, fileHash } from '../encryption.ts';
import { verify, restoreLocal } from '../cli.ts';
import { CloudflareApi } from '../../deploy/cloudflare.ts';

let root: string,
  origin: string,
  source: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database; FILES: R2Bucket }>>>;
let child: ChildProcess;
let snapshot: Awaited<ReturnType<typeof captureAndDrill>>;
let control: OperatorClient;
const release = 'a'.repeat(40);
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);
const headers = { authorization: 'Bearer invented-app-token', 'content-type': 'application/json' };

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'billionaire-workflow-test-'));
  const portServer = createServer();
  await new Promise<void>((r) => portServer.listen(0, '127.0.0.1', r));
  const address = portServer.address();
  if (!address || typeof address === 'string') throw new Error('No local port');
  const port = address.port;
  await new Promise<void>((r) => portServer.close(() => r()));
  origin = `http://127.0.0.1:${port}`;
  const bindings = {
    d1_databases: [
      {
        binding: 'DB',
        database_name: 'manaclaude',
        database_id: '00000000-0000-0000-0000-000000000000',
      },
    ],
    r2_buckets: [{ binding: 'FILES', bucket_name: 'recovery-files' }],
  };
  const inert = join(root, 'inert.json');
  await writeFile(
    inert,
    JSON.stringify({ name: 'invented-source', compatibility_date: '2026-10-15', ...bindings }),
  );
  source = await getPlatformProxy({
    configPath: inert,
    remoteBindings: false,
    persist: { path: join(root, 'state', 'v3') },
  });
  await source.env.DB.prepare(
    'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)',
  ).run();
  for (const [i, migration] of (
    await readD1Migrations(new URL('../../migrations/', import.meta.url).pathname)
  ).entries()) {
    await source.env.DB.batch(migration.queries.map((s) => source.env.DB.prepare(s)));
    await source.env.DB.prepare('INSERT INTO d1_migrations VALUES (?,?,?)')
      .bind(i + 1, migration.name, '2026-11-16T12:00:00Z')
      .run();
  }
  await source.env.FILES.put('invented-extra/not-referenced', '', {
    httpMetadata: {
      contentType: 'text/plain',
      cacheControl: 'private',
      contentDisposition: 'attachment; filename="invented.txt"',
    },
    customMetadata: { invented: 'retained' },
  });
  const config = join(root, 'dev.json');
  await writeFile(
    config,
    JSON.stringify({
      name: 'invented-recovery-worker',
      main: fileURLToPath(new URL('../../src/index.ts', import.meta.url)),
      compatibility_date: '2026-10-15',
      compatibility_flags: ['nodejs_compat'],
      ...bindings,
      kv_namespaces: [{ binding: 'OAUTH_KV', id: '00000000000000000000000000000000' }],
      durable_objects: {
        bindings: [{ name: 'MAINTENANCE', class_name: 'MaintenanceCoordinator' }],
      },
      migrations: [{ tag: 'maintenance-v1', new_sqlite_classes: ['MaintenanceCoordinator'] }],
      vars: {
        APP_API_TOKEN: 'invented-app-token',
        RECOVERY_OPERATOR_TOKEN: 'invented-operator-token',
        ALLOW_SAMPLE_SEED: 'true',
        RELEASE_COMMIT: release,
        PUBLIC_URL: origin,
        PLAID_LINK_ENABLED: 'false',
      },
    }),
  );
  child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('../../../node_modules/wrangler/bin/wrangler.js', import.meta.url)),
      'dev',
      '--local',
      '--config',
      config,
      '--port',
      String(port),
      '--persist-to',
      join(root, 'state'),
      '--test-scheduled',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let diagnostic = '';
  child.stdout?.on('data', (b) => {
    diagnostic += String(b);
  });
  child.stderr?.on('data', (b) => {
    diagnostic += String(b);
  });
  const end = Date.now() + 90_000;
  for (;;) {
    try {
      if ((await fetch(origin + '/health')).ok) break;
    } catch {
      /* local startup */
    }
    if (Date.now() > end || child.exitCode !== null) {
      await writeFile(join(root, 'startup.private'), diagnostic);
      throw new Error('Local wrangler dev did not start');
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(
    (
      await fetch(origin + '/v1/settings', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ aiEnabled: false }),
      })
    ).status,
  ).toBe(200);
  const accountResponse = await fetch(origin + '/v1/accounts/manual', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      idempotencyKey: 'invented-recovery-account',
      name: 'Invented savings',
      type: 'savings',
      currency: 'USD',
      currentBalance: null,
    }),
  });
  expect(accountResponse.status).toBe(201);
  const account = (await accountResponse.json()) as { account: { id: string } };
  const form = new FormData();
  form.set('accountId', account.account.id);
  form.set(
    'file',
    new File(['Date,Description,Amount\n2026-11-01,Invented purchase,-1.00\n'], 'invented.csv', {
      type: 'text/csv',
    }),
  );
  expect(
    (
      await fetch(origin + '/v1/imports', {
        method: 'POST',
        headers: { authorization: headers.authorization },
        body: form,
      })
    ).status,
  ).toBe(201);
  const receipt = new FormData();
  receipt.set('file', new File([png], 'invented.png', { type: 'image/png' }));
  expect(
    (
      await fetch(origin + '/v1/receipts', {
        method: 'POST',
        headers: { authorization: headers.authorization },
        body: receipt,
      })
    ).status,
  ).toBe(201);
  control = new OperatorClient(origin, 'invented-operator-token');
  await control.maintenance(true);
  const sourceHold = await control.drain(1_000, 10);
  expect(sourceHold.drained).toBe(true);
  const dump = await source.env.DB.prepare('PRAGMA miniflare_d1_export(?,?,?);')
    .bind(false, false)
    .raw<string[]>();
  const sql = join(root, 'source.sql');
  await writeFile(sql, dump[0]!.join('\n'), { mode: 0o600 });
  snapshot = await captureAndDrill(control, sql, root, undefined, sourceHold);
}, 180_000);

afterAll(async () => {
  child?.kill('SIGTERM');
  if (child && child.exitCode === null)
    await Promise.race([
      new Promise((r) => child.once('exit', r)),
      new Promise((r) => setTimeout(r, 2_000)),
    ]);
  if (child?.exitCode === null) child.kill('SIGKILL');
  await source?.dispose();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('GitHub recovery flow against real wrangler dev', () => {
  it('captures all originals AND an empty unreferenced object, exact metadata and both revisions', async () => {
    expect(snapshot.manifest.files).toHaveLength(2);
    expect(snapshot.manifest.bucket).toHaveLength(3);
    expect(snapshot.image.triggers).toHaveLength(24);
    expect(
      snapshot.manifest.bucket?.find((o) => o.key === 'invented-extra/not-referenced'),
    ).toMatchObject({ bytes: 0, customMetadata: { invented: 'retained' } });
    await expect(access(join(root, 'restore-drill'))).rejects.toThrow();
    for (const name of ['history_revision', 'investment_revision']) {
      const current = (await source.env.DB.prepare(`SELECT * FROM ${name}`).all()).results;
      expect(canonical(current)).toBe(
        canonical(snapshot.image.tables.find((t) => t.name === name)?.rows),
      );
    }
    for (const cron of ['*/5 * * * *', '0 * * * *', '30 6 * * *', '2-57/5 * * * *'])
      expect((await fetch(origin + '/__scheduled?cron=' + encodeURIComponent(cron))).ok).toBe(true);
    expect((await control.status()).drained).toBe(true);
  });
  it('encrypts one portable authenticated file, reopens it, verifies and restores every object locally', async () => {
    const encrypted = join(root, 'backup.enc'),
      passphrase = 'invented passphrase for local recovery tests only';
    const result = await encryptBackup(root, encrypted, passphrase);
    expect(result.encryptedSha256).toBe(await fileHash(encrypted));
    expect((await readFile(encrypted)).includes(Buffer.from('Invented purchase'))).toBe(false);
    const opened = await decryptBackup(encrypted, join(root, 'reopened'), passphrase);
    const capture = JSON.parse(await readFile(join(opened, 'capture.json'), 'utf8'));
    expect(
      (await verify(join(opened, 'bundle'), capture.manifestSha256)).manifest.bucket,
    ).toHaveLength(3);
    await restoreLocal(
      join(opened, 'bundle'),
      capture.manifestSha256,
      join(root, 'portable-drill'),
    );
    await rm(join(root, 'portable-drill'), { recursive: true, force: true });
    await rm(opened, { recursive: true, force: true });
    await expect(
      decryptBackup(encrypted, join(root, 'wrong-password'), 'a different invented passphrase'),
    ).rejects.toThrow(/Decryption/);
    await expect(access(join(root, 'wrong-password'))).rejects.toThrow();
    const damaged = await readFile(encrypted);
    damaged[damaged.length - 20]! ^= 1;
    await writeFile(join(root, 'tampered.enc'), damaged);
    await expect(
      decryptBackup(join(root, 'tampered.enc'), join(root, 'damaged'), passphrase),
    ).rejects.toThrow(/Decryption/);
    await expect(access(join(root, 'damaged'))).rejects.toThrow();
  }, 60_000);
  it('rejects missing or changed whole-bucket objects and keeps maintenance on', async () => {
    const { cp } = await import('node:fs/promises');
    const damaged = join(root, 'bad-bundle');
    await cp(join(root, 'bundle'), damaged, { recursive: true });
    await rm(join(damaged, 'bucket-object-000000'));
    await expect(verify(damaged, snapshot.result.manifestSha256)).rejects.toThrow();
    expect((await control.status()).on).toBe(true);
    expect(
      (await fetch(origin + '/v1/settings', { method: 'PATCH', headers, body: '{}' })).status,
    ).toBe(503);
  });
  it('reports read-only rollout checks and fails closed for unexpected state without logging private rows', async () => {
    let nonzero = false;
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const sql = init?.body ? (JSON.parse(String(init.body)) as { sql?: string }).sql : undefined;
      let result: unknown;
      if (String(_url).endsWith('/subdomain')) result = { enabled: true, previews_enabled: false };
      else if (!sql)
        result = String(_url).endsWith('/deployments')
          ? { deployments: [{ versions: [{ version_id: 'invented-version', percentage: 100 }] }] }
          : {
              resources: {
                bindings: [
                  { name: 'RELEASE_COMMIT', text: release },
                  { name: 'PUBLIC_URL', text: origin },
                  { name: 'DB', id: 'invented-db' },
                  { name: 'FILES', bucket_name: 'manaclaude-files' },
                ],
              },
            };
      else {
        let rows: unknown[] = [];
        if (sql.includes('d1_migrations'))
          rows = snapshot.image.tables
            .find((t) => t.name === 'd1_migrations')!
            .rows.map((r) => ({ name: r.name }))
            .sort((a, b) => String(a.name).localeCompare(String(b.name)));
        else if (sql.includes('sqlite_schema'))
          rows = snapshot.image.triggers.map((sql) => ({ sql }));
        else if (sql.includes('count(*)')) rows = [{ count: nonzero ? 1 : 0 }];
        else rows = snapshot.image.tables.find((t) => sql.endsWith(t.name))!.rows;
        result = [{ success: true, results: rows }];
      }
      return Response.json({ success: true, result });
    });
    const api = new CloudflareApi('invented-token', 'invented-account', transport as typeof fetch);
    const output: unknown[] = [];
    const emit = (value: unknown) => {
      output.push(value);
    };
    {
      await rolloutChecks(api, 'invented-db', control, release, snapshot, emit);
      expect(output).toContain('3a passed');
      expect(output).toContain('3b passed');
      expect(output).toContain('3d passed');
      nonzero = true;
      await expect(
        rolloutChecks(api, 'invented-db', control, release, snapshot, emit),
      ).rejects.toThrow(/3d failed/);
      expect(JSON.stringify(output)).not.toContain('Invented purchase');
      expect(
        transport.mock.calls
          .filter(([, i]) => i?.body)
          .every(([, i]) => String(i?.body).includes('SELECT')),
      ).toBe(true);
    }
    expect((await control.status()).on).toBe(true);
  });
  it('uses a purpose-specific derived operator credential and never an app/provider secret', () => {
    expect(operatorToken('invented-token', 'invented-account')).toMatch(/^[a-f0-9]{64}$/);
    expect(operatorToken('invented-token', 'invented-account')).not.toBe(sha256('invented-token'));
    expect(operatorToken('invented-token', 'another-account')).not.toBe(
      operatorToken('invented-token', 'invented-account'),
    );
  });
  it('does not expose filesystem object keys as archive paths', async () => {
    expect(
      (await readdir(join(root, 'bundle'))).every((n) =>
        /^(manifest\.json|database\.sql|(?:bucket-)?object-\d+)$/.test(n),
      ),
    ).toBe(true);
  });
  it('rejects an export taken under a previous maintenance hold before creating a bundle', async () => {
    const hold = await control.status();
    await control.maintenance(true);
    const output = join(root, 'raced-capture');
    await mkdir(output);
    await expect(
      captureAndDrill(control, join(root, 'source.sql'), output, undefined, hold),
    ).rejects.toThrow('across D1 export');
    await expect(access(join(output, 'bundle'))).rejects.toThrow();
  });
});
