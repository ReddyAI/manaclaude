import { mkdir, readFile, writeFile, realpath, lstat, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { getPlatformProxy } from 'wrangler';
import { z } from 'zod';
import {
  canonical,
  inspectDatabase,
  MAX_FILE_BYTES,
  MAX_SQL_BYTES,
  RecoveryError,
  quote,
  sha256,
  tableInventory,
  validateFile,
  type FileReference,
} from './data.ts';

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const manifestSchema = z.object({
  format: z.literal('manaclaude-recovery-v1'),
  createdAt: z.iso.datetime(),
  database: z.object({ bytes: z.number().int().min(1).max(MAX_SQL_BYTES), sha256: hashSchema }),
  tables: z.array(
    z.object({ name: z.string(), rows: z.number().int().min(0), sha256: hashSchema }),
  ),
  files: z.array(
    z.object({
      kind: z.enum(['statement', 'receipt']),
      id: z.string(),
      key: z.string(),
      contentType: z.string(),
      bytes: z.number().int().min(1).max(MAX_FILE_BYTES),
      sha256: hashSchema,
      customMetadata: z.record(z.string(), z.string()),
    }),
  ),
});
export type RecoveryManifest = z.infer<typeof manifestSchema>;
const repo = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const objectName = (i: number) => `object-${i.toString().padStart(6, '0')}`;

/** Require a new directory outside every Git checkout, resolving parent symlinks. */
export async function privateDirectory(output: string) {
  if (!isAbsolute(output)) throw new RecoveryError('Use an absolute private path outside Git.');
  const parent = await realpath(dirname(output));
  const dest = join(parent, output.split(sep).at(-1)!);
  if (dest === repo || dest.startsWith(repo + sep))
    throw new RecoveryError('Backup paths must be outside Git.');
  for (let p = parent; ; p = dirname(p)) {
    const git = await lstat(join(p, '.git')).catch(() => null);
    const head = git?.isDirectory() && (await lstat(join(p, '.git', 'HEAD')).catch(() => null));
    if (git?.isFile() || head) throw new RecoveryError('Backup paths must be outside Git.');
    if (p === dirname(p)) break;
  }
  await mkdir(dest, { mode: 0o700 }).catch(() => {
    throw new RecoveryError(
      'Destination must be new and writable; existing directories are never reused.',
    );
  });
  return dest;
}

async function privateWrite(path: string, bytes: string | Uint8Array) {
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
}

async function boundedRead(path: string, max: number) {
  const stat = await lstat(path).catch(() => {
    throw new RecoveryError('Required input or bundle file is missing or unreadable.');
  });
  if (!stat.isFile() || stat.size > max)
    throw new RecoveryError('Missing, unsafe or oversized bundle file.');
  return readFile(path);
}

export function httpFileReader(apiUrl: string, token: string) {
  const base = new URL(apiUrl);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== '/' ||
    (base.protocol !== 'https:' &&
      !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)))
  )
    throw new RecoveryError('Use the Worker HTTPS origin (HTTP is allowed only on loopback).');
  if (!token)
    throw new RecoveryError('APP_API_TOKEN must be supplied privately through the environment.');
  return async (ref: FileReference) => {
    const path =
      ref.kind === 'statement'
        ? `vault/${encodeURIComponent(ref.id)}/file`
        : `receipts/${encodeURIComponent(ref.id)}/image`;
    const response = await fetch(new URL(`/v1/${path}`, base), {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok || !response.body)
      throw new RecoveryError(
        `Original-file download failed (HTTP ${response.status}); no complete backup.`,
      );
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_FILE_BYTES) throw new RecoveryError('Original file exceeds 20 MiB.');
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return {
      bytes: Buffer.concat(chunks),
      contentType: response.headers.get('content-type') ?? '',
    };
  };
}

export async function backup(options: {
  sqlPath: string;
  output: string;
  writersStopped: boolean;
  readFile: ReturnType<typeof httpFileReader>;
}) {
  if (!options.writersStopped)
    throw new RecoveryError('Stop all writers before D1 export and file capture.');
  const sql = await boundedRead(options.sqlPath, MAX_SQL_BYTES);
  const image = inspectDatabase(sql.toString('utf8'));
  const dest = await privateDirectory(options.output);
  try {
    await privateWrite(join(dest, 'database.sql'), sql);
    const manifest: RecoveryManifest = {
      format: 'manaclaude-recovery-v1',
      createdAt: new Date().toISOString(),
      database: { bytes: sql.length, sha256: sha256(sql) },
      tables: tableInventory(image),
      files: [],
    };
    for (const [i, ref] of image.files.entries()) {
      const { bytes, contentType } = await options.readFile(ref);
      validateFile(ref, bytes, contentType);
      await privateWrite(join(dest, objectName(i)), bytes);
      manifest.files.push({
        kind: ref.kind,
        id: ref.id,
        key: ref.key,
        customMetadata: ref.customMetadata,
        contentType,
        bytes: bytes.length,
        sha256: sha256(bytes),
      });
    }
    // Written last: failed captures never leave a complete-looking manifest.
    const manifestBytes = JSON.stringify(manifest, null, 2) + '\n';
    await privateWrite(join(dest, 'manifest.json'), manifestBytes);
    return {
      manifestSha256: sha256(manifestBytes),
      tables: manifest.tables.length,
      files: manifest.files.length,
    };
  } catch (error) {
    await rm(dest, { recursive: true, force: true });
    throw error;
  }
}

export async function verify(bundle: string, expectedManifestSha256: string) {
  hashSchema.parse(expectedManifestSha256);
  const raw = await boundedRead(join(bundle, 'manifest.json'), MAX_SQL_BYTES);
  if (sha256(raw) !== expectedManifestSha256) throw new RecoveryError('Manifest SHA-256 mismatch.');
  const manifest = manifestSchema.parse(JSON.parse(raw.toString('utf8')));
  const sql = await boundedRead(join(bundle, 'database.sql'), MAX_SQL_BYTES);
  if (sql.length !== manifest.database.bytes || sha256(sql) !== manifest.database.sha256)
    throw new RecoveryError('Database size or SHA-256 mismatch.');
  const image = inspectDatabase(sql.toString('utf8'));
  if (canonical(tableInventory(image)) !== canonical(manifest.tables))
    throw new RecoveryError('Database table inventory mismatch.');
  if (image.files.length !== manifest.files.length)
    throw new RecoveryError('Incomplete file inventory.');
  for (const [i, ref] of image.files.entries()) {
    const f = manifest.files[i]!;
    if (
      ref.id !== f.id ||
      ref.key !== f.key ||
      ref.kind !== f.kind ||
      canonical(ref.customMetadata) !== canonical(f.customMetadata)
    )
      throw new RecoveryError('File relationship mismatch.');
    const bytes = await boundedRead(join(bundle, objectName(i)), MAX_FILE_BYTES);
    if (bytes.length !== f.bytes || sha256(bytes) !== f.sha256)
      throw new RecoveryError(`Object ${i} size or SHA-256 mismatch.`);
    validateFile(ref, bytes, f.contentType);
  }
  return { image, manifest };
}

/** A deliberately inert configuration: no app entry, AI, secrets, cron or remote bindings. */
export async function localStore(directory: string) {
  const configPath = join(directory, 'wrangler.json');
  await privateWrite(
    configPath,
    JSON.stringify({
      name: 'manaclaude-recovery-local',
      compatibility_date: '2026-10-15',
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'recovery',
          database_id: '00000000-0000-0000-0000-000000000000',
        },
      ],
      r2_buckets: [{ binding: 'FILES', bucket_name: 'recovery-files' }],
    }),
  );
  return getPlatformProxy<{ DB: D1Database; FILES: R2Bucket }>({
    configPath,
    remoteBindings: false,
    persist: { path: join(directory, 'state') },
  });
}

export async function restoreLocal(bundle: string, manifestSha256: string, output: string) {
  // Verify everything before creating/writing a destination.
  const { image, manifest } = await verify(bundle, manifestSha256);
  const dest = await privateDirectory(output);
  const store = await localStore(dest);
  try {
    const { DB, FILES } = store.env;
    for (const t of image.tables) await DB.prepare(t.sql).run();
    // The current schema's FK parents (accounts/connections) sort before their children.
    // Bounded local batches avoid sending a full history through a Worker request.
    for (const t of image.tables) {
      for (let start = 0; start < t.rows.length; start += 100) {
        const statements = t.rows
          .slice(start, start + 100)
          .map((r) =>
            DB.prepare(
              `INSERT INTO ${quote(t.name)} (${t.columns.map(quote).join(',')}) VALUES (${t.columns.map(() => '?').join(',')})`,
            ).bind(...t.columns.map((c) => r[c])),
          );
        await DB.batch([DB.prepare('PRAGMA defer_foreign_keys = ON'), ...statements]);
      }
    }
    for (const sql of image.indexes) await DB.prepare(sql).run();
    for (const [i, f] of manifest.files.entries()) {
      const bytes = await boundedRead(join(bundle, objectName(i)), MAX_FILE_BYTES);
      if (sha256(bytes) !== f.sha256) throw new RecoveryError('Object changed during restoration.');
      await FILES.put(f.key, bytes, {
        httpMetadata: { contentType: f.contentType },
        customMetadata: f.customMetadata,
      });
    }
    // Reuse the same native SQL exporter that Wrangler uses for local D1.
    const dump = await DB.prepare('PRAGMA miniflare_d1_export(?,?,?);')
      .bind(false, false)
      .raw<string[]>();
    const restored = inspectDatabase(dump[0]!.join('\n'));
    if (
      canonical(tableInventory(restored)) !== canonical(manifest.tables) ||
      canonical(restored.indexes) !== canonical(image.indexes)
    )
      throw new RecoveryError('Restored database differs from the backup.');
    for (const f of manifest.files) {
      const obj = await FILES.get(f.key);
      if (
        !obj ||
        sha256(new Uint8Array(await obj.arrayBuffer())) !== f.sha256 ||
        obj.size !== f.bytes ||
        obj.httpMetadata?.contentType !== f.contentType ||
        canonical(obj.customMetadata) !== canonical(f.customMetadata)
      )
        throw new RecoveryError('Restored object or metadata differs from the backup.');
    }
    const report = {
      scope: 'local-restoration-only',
      manifestSha256,
      tables: manifest.tables,
      files: manifest.files.length,
    };
    await privateWrite(join(dest, 'verified.json'), JSON.stringify(report, null, 2) + '\n');
    return { tables: manifest.tables.length, files: manifest.files.length };
  } finally {
    await store.dispose();
  }
}

export async function main(args: string[]) {
  process.umask(0o077);
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      sql: { type: 'string' },
      output: { type: 'string' },
      'api-url': { type: 'string' },
      bundle: { type: 'string' },
      'manifest-sha256': { type: 'string' },
      'writers-stopped': { type: 'boolean' },
    },
  });
  const command = positionals[0];
  if (positionals.length !== 1) throw new RecoveryError('Choose backup, verify or restore-local.');
  if (command === 'backup' && values.sql && values.output && values['api-url']) {
    return backup({
      sqlPath: values.sql,
      output: values.output,
      writersStopped: values['writers-stopped'] === true,
      readFile: httpFileReader(values['api-url'], process.env.APP_API_TOKEN ?? ''),
    });
  }
  if (values.bundle && values['manifest-sha256']) {
    if (command === 'verify') {
      const { manifest } = await verify(values.bundle, values['manifest-sha256']);
      return { tables: manifest.tables.length, files: manifest.files.length };
    }
    if (command === 'restore-local' && values.output)
      return restoreLocal(values.bundle, values['manifest-sha256'], values.output);
  }
  throw new RecoveryError(
    'Missing arguments. See the recovery instructions in docs/handoff/codex-log.md.',
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2))
    .then((result) => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch((error: unknown) => {
      // SQL/parser/network errors can contain private records or URLs. Keep stderr generic.
      console.error(
        error instanceof RecoveryError
          ? error.message
          : 'Recovery failed; no verified result. Check arguments, stopped writers, source access, bundle integrity and a new private destination.',
      );
      process.exitCode = 1;
    });
}
