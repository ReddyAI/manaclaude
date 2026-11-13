import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, stat, cp, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readD1Migrations } from '@cloudflare/vitest-plugin';
import { getPlatformProxy } from 'wrangler';
import type { Env } from '../../src/env';
import { createApp } from '../../src/api/app';
import { createManualAccount, manualAccountSchema } from '../../src/services/accounts';
import { ensureDefaultCategories } from '../../src/services/seed';
import { updateSettings } from '../../src/services/settings';
import { makeTransaction } from '../../src/services/transactions';
import { insertStatement } from '../../src/db/table';
import { transactionsTable } from '../../src/db/tables';
import { splitTransaction } from '../../src/services/splits';
import { linkManually } from '../../src/services/links';
import { previewImport, commitImport, undoImport, discardImport } from '../../src/imports/service';
import { uploadReceipt } from '../../src/receipts/service';
import { loadCredentials, saveCredentials } from '../../src/sync/credentials';
import { runNightlyStep, type NightlyState } from '../../src/nightly';
import { backfillMissingHistory } from '../../src/fx/service';
import { loadDataset } from '../../src/services/dataset';
import {
  backup,
  httpFileReader,
  localStore,
  main,
  privateDirectory,
  restoreLocal,
  verify,
} from '../cli.ts';
import { canonical, inspectDatabase, sha256 } from '../data.ts';

const now = '2026-11-12T12:00:00.000Z';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);
let root: string;
let env: Env;
let source: Awaited<ReturnType<typeof localStore>>;
let server: Server;
let origin: string;
let sqlPath: string;
let sql: string;
let bundle: string;
let digest: string;
const requests: string[] = [];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'manaclaude-recovery-test-'));
  source = await localStore(await privateDirectory(join(root, 'source')));
  env = {
    ...source.env,
    APP_API_TOKEN: 'invented-recovery-api-token',
    CREDENTIALS_SECRET: 'invented-recovery-encryption-secret',
  } as Env;
  await env.DB.prepare(
    'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL)',
  ).run();
  for (const migration of await readD1Migrations(
    new URL('../../migrations/', import.meta.url).pathname,
  )) {
    await env.DB.batch(migration.queries.map((s) => env.DB.prepare(s)));
    await env.DB.prepare('INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)')
      .bind(migration.name, now)
      .run();
  }
  await ensureDefaultCategories(env.DB);
  await updateSettings(env.DB, { aiEnabled: false });
  const known = await createManualAccount(
    env.DB,
    manualAccountSchema.parse({
      idempotencyKey: 'invented-known',
      name: 'Orchard savings',
      type: 'savings',
      currency: 'INR',
      subtype: 'nre',
      currentBalance: { amount: 45000, asOf: now },
      openingBalance: { amount: 20000, date: '2025-01-01' },
    }),
    () => new Date(now),
  );
  const unknown = await createManualAccount(
    env.DB,
    manualAccountSchema.parse({
      idempotencyKey: 'invented-unknown',
      name: 'Meadow checking',
      type: 'checking',
      currency: 'INR',
      currentBalance: null,
    }),
    () => new Date(now),
  );
  const category = await env.DB.prepare('SELECT id FROM categories LIMIT 1').first<string>('id');
  for (const [id, accountId, amount] of [
    ['parent', known.account.id, -10000],
    ['out', known.account.id, -5000],
    ['in', unknown.account.id, 5000],
  ] as const) {
    await insertStatement(
      env.DB,
      transactionsTable,
      makeTransaction({
        id,
        accountId,
        amount,
        currency: 'INR',
        date: '2026-11-01',
        source: 'manual',
        rawName: 'Invented purchase',
        notes: "Invented café note; 'quoted'\n第二行",
        categoryId: category,
        userEditedFields: ['notes', 'categoryId'],
      }),
    ).run();
  }
  await splitTransaction(env.DB, {
    parentTransactionId: 'parent',
    idempotencyKey: 'invented-split',
    lines: [
      { amount: -4000, categoryId: category, notes: 'First invented part' },
      { amount: -6000, categoryId: category, notes: 'Second invented part' },
    ],
  });
  await linkManually(env.DB, 'out', 'in');
  await uploadReceipt(env, {
    bytes: new Uint8Array(png),
    contentType: 'image/png',
    transactionId: 'parent',
  });
  for (const [status, amount] of [
    ['committed', '-3.21'],
    ['undone', '-4.32'],
    ['discarded', '-5.43'],
  ] as const) {
    const preview = await previewImport(env, {
      bytes: new TextEncoder().encode(
        `Date,Description,Amount\n2026-11-02,Invented ${status},${amount}\n`,
      ),
      fileName: `${status}.csv`,
      contentType: 'text/csv',
      accountId: known.account.id,
    });
    if (status === 'discarded') await discardImport(env.DB, preview.importId);
    else {
      await commitImport(env, preview.importId, {}, () => new Date(now));
      if (status === 'undone') await undoImport(env.DB, preview.importId);
    }
  }
  // The existing encryption implementation is used unchanged, with an invented key/token.
  await env.DB.prepare(
    'INSERT INTO connections (id, connector_id, institution_name, status, sync_cursor, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      'invented-connection',
      'simplefin',
      'Invented provider',
      'error',
      'invented-history-cursor',
      now,
      now,
    )
    .run();
  await env.DB.prepare('INSERT INTO sync_retries VALUES (?, ?, ?)')
    .bind('invented-connection', 2, 1794484800000)
    .run();
  await env.DB.prepare('INSERT INTO connector_slots VALUES (?, ?)').bind('simplefin', 1).run();
  await env.DB.prepare(
    'INSERT INTO link_sessions (id, connector_id, status, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind('invented-link-session', 'simplefin', 'done', now, now, now)
    .run();
  await saveCredentials(env, 'invented-connection', { token: 'invented-provider-token' });
  // An interrupted FX owner plus previously committed progress must survive a backup.
  await env.DB.prepare(
    "INSERT INTO fx_backfill_progress VALUES ('INR', '2026-11-01', '2026-11-03')",
  ).run();
  await env.DB.prepare(
    "INSERT INTO fx_rates VALUES ('USD', 'INR', 80, '2026-10-30T15:00:00.000Z', '2026-10-30', 'frankfurter_ecb'), ('USD', 'INR', 80, '2026-11-02T15:00:00.000Z', '2026-11-02', 'frankfurter_ecb')",
  ).run();
  await env.DB.prepare(
    "INSERT INTO fx_backfill_scheduler VALUES (1, 'GBP', 'invented-abandoned-fx-lease', 1794484800000)",
  ).run();
  const nightly: NightlyState = {
    day: '2026-11-12',
    phase: 'merchants',
    after: '',
    alert: null,
    categorize: null,
    recap: null,
  };
  await env.DB.prepare('INSERT INTO nightly_state VALUES (1, ?, ?, ?)')
    .bind(JSON.stringify(nightly), 'invented-abandoned-nightly-lease', 1794484800000)
    .run();
  const dump = await env.DB.prepare('PRAGMA miniflare_d1_export(?,?,?);')
    .bind(false, false)
    .raw<string[]>();
  sql = dump[0]!.join('\n');
  sqlPath = join(root, 'source.sql');
  await writeFile(sqlPath, sql, { mode: 0o600 });
  const app = createApp();
  server = createServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const result = await app.fetch(
      new Request(new URL(req.url!, origin), {
        headers: { Authorization: req.headers.authorization ?? '' },
      }),
      env,
    );
    res.writeHead(result.status, Object.fromEntries(result.headers));
    res.end(Buffer.from(await result.arrayBuffer()));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test listener.');
  origin = `http://127.0.0.1:${address.port}`;
  bundle = join(root, 'bundle');
  const result = await backup({
    sqlPath,
    output: bundle,
    writersStopped: true,
    readFile: httpFileReader(origin, env.APP_API_TOKEN!),
  });
  digest = result.manifestSha256;
}, 60_000);

afterAll(async () => {
  if (server) await new Promise<void>((done) => server.close(() => done()));
  await source?.dispose();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('private D1 and original-file recovery', () => {
  it('runs the documented verify command directly in Node', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL('../cli.ts', import.meta.url)),
      'verify',
      '--bundle',
      bundle,
      '--manifest-sha256',
      digest,
    ]);
    expect(JSON.parse(stdout)).toEqual({ tables: 44, files: 4 });
  });
  it('restores all records, balances, notes, categories, splits, transfers and originals to new local D1/R2', async () => {
    const restored = join(root, 'restored');
    const result = await restoreLocal(bundle, digest, restored);
    expect(result).toEqual({ tables: 44, files: 4 });
    const target = await getPlatformProxy<Env>({
      configPath: join(restored, 'wrangler.json'),
      remoteBindings: false,
      persist: { path: join(restored, 'state') },
    });
    try {
      const normalizeDataset = (data: Awaited<ReturnType<typeof loadDataset>>) =>
        Object.fromEntries(
          Object.entries(data).map(([key, value]) => [
            key,
            Array.isArray(value) ? value.map(canonical).sort() : value,
          ]),
        );
      expect(normalizeDataset(await loadDataset(target.env.DB))).toEqual(
        normalizeDataset(await loadDataset(env.DB)),
      );
      expect(
        await loadCredentials(
          { ...target.env, CREDENTIALS_SECRET: env.CREDENTIALS_SECRET },
          'invented-connection',
        ),
      ).toEqual({ token: 'invented-provider-token' });
      await expect(
        loadCredentials(
          { ...target.env, CREDENTIALS_SECRET: 'different-invented-key' },
          'invented-connection',
        ),
      ).rejects.toThrow(/could not be decrypted/);
      const image = inspectDatabase(sql);
      for (const t of image.tables) {
        const actual = await target.env.DB.prepare(`SELECT * FROM "${t.name}"`).all();
        const original = await env.DB.prepare(`SELECT * FROM "${t.name}"`).all();
        expect(actual.results.map(canonical).sort()).toEqual(
          original.results.map(canonical).sort(),
        );
      }
      for (const f of image.files) {
        const original = await env.FILES.get(f.key);
        const copy = await target.env.FILES.get(f.key);
        expect(Buffer.from(await copy!.arrayBuffer())).toEqual(
          Buffer.from(await original!.arrayBuffer()),
        );
        expect(copy!.httpMetadata).toEqual(original!.httpMetadata);
        expect(copy!.customMetadata ?? {}).toEqual(original!.customMetadata ?? {});
      }
      const fxCalls: string[] = [];
      await backfillMissingHistory(
        target.env,
        async (url) => {
          fxCalls.push(url);
          const date = new URL(url).pathname.split('/').at(-1)!;
          return Response.json({ amount: 1, base: 'USD', date, rates: { INR: 80 } });
        },
        { now: () => new Date('2026-11-13T12:00:00Z'), through: '2026-11-04' },
      );
      expect(fxCalls.map((url) => new URL(url).pathname)).toEqual([
        '/v1/2026-11-03',
        '/v1/2026-11-04',
      ]);
      expect(
        await target.env.DB.prepare(
          "SELECT next_date FROM fx_backfill_progress WHERE quote='INR'",
        ).first('next_date'),
      ).toBe('2026-11-05');
      expect(
        await target.env.DB.prepare('SELECT lease_token FROM fx_backfill_scheduler').first(
          'lease_token',
        ),
      ).toBeNull();
      expect(
        await env.DB.prepare("SELECT next_date FROM fx_backfill_progress WHERE quote='INR'").first(
          'next_date',
        ),
      ).toBe('2026-11-03');
      const savedNightly = await env.DB.prepare('SELECT state FROM nightly_state').first<string>(
        'state',
      );
      await runNightlyStep(target.env, new Date('2026-11-13T06:32:00Z'), {
        now: () => new Date('2026-11-13T12:00:00Z'),
      });
      const resumed = await target.env.DB.prepare(
        'SELECT state, lease_token FROM nightly_state',
      ).first<{ state: string; lease_token: string | null }>();
      expect(JSON.parse(resumed!.state).after).not.toBe('');
      expect(resumed!.lease_token).toBeNull();
      expect(await env.DB.prepare('SELECT state FROM nightly_state').first('state')).toBe(
        savedNightly,
      );
      expect(JSON.parse(await readFile(join(restored, 'verified.json'), 'utf8')).scope).toBe(
        'local-restoration-only',
      );
    } finally {
      await target.dispose();
    }
    expect(requests).toHaveLength(4);
    expect(requests.every((r) => /^GET \/v1\/(vault\/.*\/file|receipts\/.*\/image)$/.test(r))).toBe(
      true,
    );
    expect((await stat(bundle)).mode & 0o777).toBe(0o700);
    for (const name of ['database.sql', 'manifest.json', 'object-000000'])
      expect((await stat(join(bundle, name))).mode & 0o777).toBe(0o600);
  }, 60_000);

  it.each(['database.sql', 'object-000000', 'manifest.json'])(
    'rejects corrupt %s before creating a restore target',
    async (name) => {
      const damaged = join(root, `corrupt-${name}`);
      await cp(bundle, damaged, { recursive: true });
      await writeFile(join(damaged, name), 'corrupt invented bytes');
      const dest = join(root, `not-created-${name}`);
      await expect(restoreLocal(damaged, digest, dest)).rejects.toThrow(/SHA-256/);
      await expect(access(dest)).rejects.toThrow();
    },
  );

  it('rejects a missing receipt and symlinked object', async () => {
    const damaged = join(root, 'missing');
    await cp(bundle, damaged, { recursive: true });
    await rm(join(damaged, 'object-000000'));
    await expect(verify(damaged, digest)).rejects.toThrow();
    await symlink(join(bundle, 'object-000000'), join(damaged, 'object-000000'));
    await expect(verify(damaged, digest)).rejects.toThrow(/unsafe/);
  });

  it('requires stopped writers and refuses existing or Git destinations', async () => {
    const read = vi.fn();
    await expect(
      backup({ sqlPath, output: join(root, 'running'), writersStopped: false, readFile: read }),
    ).rejects.toThrow(/writers/);
    expect(read).not.toHaveBeenCalled();
    await expect(restoreLocal(bundle, digest, bundle)).rejects.toThrow();
    await expect(
      privateDirectory(new URL('../../../recovery-forbidden', import.meta.url).pathname),
    ).rejects.toThrow(/Git/);
    await expect(
      main(['restore-remote', '--bundle', bundle, '--manifest-sha256', digest]),
    ).rejects.toThrow();
  });

  it('fails capture on missing files, corrupt statements, corrupt receipts and wrong authentication', async () => {
    const realRead = httpFileReader(origin, env.APP_API_TOKEN!);
    const image = inspectDatabase(sql);
    for (const [label, read] of [
      [
        'missing',
        async (ref: (typeof image.files)[number]) => realRead({ ...ref, id: 'missing-original' }),
      ],
      [
        'corrupt',
        async (ref: (typeof image.files)[number]) => ({
          ...(await realRead(ref)),
          bytes: Buffer.from('corrupt'),
        }),
      ],
      ['auth', httpFileReader(origin, 'wrong-invented-token')],
    ] as const) {
      const output = join(root, label + '-capture');
      await expect(
        backup({ sqlPath, output, writersStopped: true, readFile: read }),
      ).rejects.toThrow();
      await expect(access(output)).rejects.toThrow();
    }
    const statement = image.files.find((f) => f.kind === 'statement')!;
    const output = join(root, 'bad-statement');
    await expect(
      backup({
        sqlPath,
        output,
        writersStopped: true,
        readFile: async (ref) =>
          ref.id === statement.id
            ? { bytes: Buffer.from('wrong'), contentType: 'text/csv' }
            : realRead(ref),
      }),
    ).rejects.toThrow(/Statement differs/);
  });

  it('rejects incomplete exports, unsafe SQL, broken relationships and active import commits', () => {
    expect(() => inspectDatabase('CREATE TABLE accounts (id TEXT);')).toThrow(/Incomplete/);
    expect(() =>
      inspectDatabase("ATTACH DATABASE '/tmp/forbidden-recovery.db' AS other;"),
    ).toThrow();
    expect(() =>
      inspectDatabase(sql + "\nUPDATE transactions SET account_id = 'missing';"),
    ).toThrow(/relationship/);
    expect(() => inspectDatabase(sql + "\nUPDATE imports SET status = 'committing';")).toThrow(
      /committing/,
    );
  });

  it('binds the exact inventory and file relationships to the trusted manifest digest', async () => {
    const modified = join(root, 'changed-manifest');
    await cp(bundle, modified, { recursive: true });
    const manifest = JSON.parse(await readFile(join(modified, 'manifest.json'), 'utf8'));
    manifest.files.pop();
    const raw = JSON.stringify(manifest);
    await writeFile(join(modified, 'manifest.json'), raw);
    await expect(verify(modified, sha256(raw))).rejects.toThrow(/Incomplete file inventory/);
  });

  it('will not transmit credentials to insecure origins or follow redirects', async () => {
    expect(() => httpFileReader('http://example.com', 'invented')).toThrow(/HTTPS/);
    expect(() => httpFileReader('https://example.com/path', 'invented')).toThrow(/HTTPS/);
    expect(() => httpFileReader('https://example.com', '')).toThrow(/APP_API_TOKEN/);
    const redirect = createServer((_req, res) => {
      res.writeHead(302, { Location: origin });
      res.end();
    });
    await new Promise<void>((done) => redirect.listen(0, '127.0.0.1', done));
    try {
      const address = redirect.address();
      if (!address || typeof address === 'string') throw new Error('No listener');
      await expect(
        httpFileReader(
          `http://127.0.0.1:${address.port}`,
          'invented',
        )(inspectDatabase(sql).files[0]!),
      ).rejects.toThrow();
    } finally {
      await new Promise<void>((done) => redirect.close(() => done()));
    }
  });
});
