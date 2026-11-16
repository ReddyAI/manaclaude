import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { privateDirectory } from './cli.ts';
import { MAX_SQL_BYTES, RecoveryError, sha256 } from './data.ts';

const magic = Buffer.from('BWRBKP01');
// Keep the single portable file below GitHub's 2 GiB release-asset upload limit.
const limit = 2 * 1024 ** 3 - 32 * 1024 ** 2;
const name = /^(capture\.json|bundle\/(manifest\.json|database\.sql|(?:bucket-)?object-\d{6,}))$/;
const entriesSchema = z.array(
  z.object({
    name: z.string().regex(name),
    bytes: z.number().int().min(0).max(MAX_SQL_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
);
function key(passphrase: string, salt: Uint8Array) {
  if (Buffer.byteLength(passphrase) < 20)
    throw new RecoveryError('BACKUP_PASSPHRASE must contain at least 20 bytes.');
  return scryptSync(passphrase, salt, 32, { N: 262144, r: 8, p: 1, maxmem: 512 * 1024 ** 2 });
}
export async function fileHash(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Fixed, bounded entry paths; no tar commands or extraction of attacker-controlled paths. */
export async function encryptBackup(root: string, output: string, passphrase: string) {
  const names = [
    'capture.json',
    ...(await readdir(join(root, 'bundle'))).map((n) => 'bundle/' + n),
  ].sort();
  const entries = [];
  for (const entry of names) {
    if (!name.test(entry)) throw new RecoveryError('Unexpected archive member.');
    const stat = await lstat(join(root, entry));
    if (!stat.isFile() || stat.size > MAX_SQL_BYTES)
      throw new RecoveryError('Unsafe archive member.');
    entries.push({ name: entry, bytes: stat.size, sha256: await fileHash(join(root, entry)) });
  }
  if (entries.reduce((n, e) => n + e.bytes, 0) > limit)
    throw new RecoveryError('Backup exceeds the portable 2 GiB archive limit.');
  const header = Buffer.from(JSON.stringify(entries));
  if (header.length > 16 * 1024 ** 2)
    throw new RecoveryError('Archive inventory exceeds its limit.');
  const plain = join(root, 'archive.private');
  const handle = await open(plain, 'wx', 0o600);
  try {
    const size = Buffer.alloc(4);
    size.writeUInt32BE(header.length);
    await handle.writeFile(size);
    await handle.writeFile(header);
    for (const entry of entries)
      for await (const chunk of createReadStream(join(root, entry.name)))
        await handle.writeFile(chunk);
  } finally {
    await handle.close();
  }
  const salt = randomBytes(16),
    iv = randomBytes(12);
  const prefix = Buffer.concat([magic, salt, iv]);
  const cipher = createCipheriv('aes-256-gcm', key(passphrase, salt), iv);
  cipher.setAAD(prefix);
  try {
    await writeFile(output, prefix, { flag: 'wx', mode: 0o600 });
    await pipeline(createReadStream(plain), cipher, createWriteStream(output, { flags: 'a' }));
    const out = await open(output, 'a');
    try {
      await out.writeFile(cipher.getAuthTag());
    } finally {
      await out.close();
    }
    return { encryptedBytes: (await lstat(output)).size, encryptedSha256: await fileHash(output) };
  } catch {
    await rm(output, { force: true });
    throw new RecoveryError('Backup encryption failed.');
  } finally {
    await rm(plain, { force: true });
  }
}

export async function decryptBackup(input: string, output: string, passphrase: string) {
  const stat = await lstat(input);
  if (!stat.isFile() || stat.size < 56 || stat.size > limit + 32 * 1024 ** 2)
    throw new RecoveryError('Invalid encrypted backup size.');
  const root = await privateDirectory(output);
  const plain = join(root, 'archive.private');
  try {
    const handle = await open(input, 'r');
    const prefix = Buffer.alloc(36),
      tag = Buffer.alloc(16);
    try {
      await handle.read(prefix, 0, 36, 0);
      await handle.read(tag, 0, 16, stat.size - 16);
    } finally {
      await handle.close();
    }
    if (!prefix.subarray(0, 8).equals(magic))
      throw new RecoveryError('Unsupported encrypted backup.');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key(passphrase, prefix.subarray(8, 24)),
      prefix.subarray(24),
    );
    decipher.setAAD(prefix);
    decipher.setAuthTag(tag);
    await pipeline(
      createReadStream(input, { start: 36, end: stat.size - 17 }),
      decipher,
      createWriteStream(plain, { flags: 'wx', mode: 0o600 }),
    );
    // Authentication MUST finish before any archive path is parsed or extracted.
    const archive = await open(plain, 'r');
    let entries: z.infer<typeof entriesSchema>;
    let offset: number;
    try {
      const size = Buffer.alloc(4);
      await archive.read(size, 0, 4, 0);
      const bytes = size.readUInt32BE();
      if (bytes > 16 * 1024 ** 2) throw new RecoveryError('Invalid archive header.');
      const header = Buffer.alloc(bytes);
      await archive.read(header, 0, bytes, 4);
      entries = entriesSchema.parse(JSON.parse(header.toString()));
      offset = bytes + 4;
    } finally {
      await archive.close();
    }
    if (
      new Set(entries.map((e) => e.name)).size !== entries.length ||
      !entries.some((e) => e.name === 'capture.json') ||
      !entries.some((e) => e.name === 'bundle/manifest.json') ||
      entries.reduce((n, e) => n + e.bytes, offset) !== (await lstat(plain)).size
    )
      throw new RecoveryError('Invalid archive inventory.');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'bundle'), { mode: 0o700 });
    for (const entry of entries) {
      const file = join(root, entry.name);
      if (entry.bytes)
        await pipeline(
          createReadStream(plain, { start: offset, end: offset + entry.bytes - 1 }),
          createWriteStream(file, { flags: 'wx', mode: 0o600 }),
        );
      else await writeFile(file, '', { flag: 'wx', mode: 0o600 });
      if (sha256(await readFile(file)) !== entry.sha256)
        throw new RecoveryError('Archive member checksum mismatch.');
      offset += entry.bytes;
    }
    return root;
  } catch {
    await rm(root, { recursive: true, force: true });
    throw new RecoveryError('Decryption or authenticated archive verification failed.');
  } finally {
    await rm(plain, { force: true });
  }
}
