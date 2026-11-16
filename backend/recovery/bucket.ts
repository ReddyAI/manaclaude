import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { canonical, MAX_FILE_BYTES, RecoveryError, sha256 } from './data.ts';

export const bucketEntry = z.object({
  key: z.string(),
  bytes: z.number().int().min(0).max(MAX_FILE_BYTES),
  etag: z.string(),
  httpMetadata: z.object({
    contentType: z.string().optional(),
    contentLanguage: z.string().optional(),
    contentDisposition: z.string().optional(),
    contentEncoding: z.string().optional(),
    cacheControl: z.string().optional(),
    cacheExpiry: z.iso.datetime().optional(),
  }),
  customMetadata: z.record(z.string(), z.string()),
});
export const bucketSchema = z.array(
  bucketEntry.extend({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
);
export type BucketEntry = z.infer<typeof bucketEntry>;
export interface BucketSource {
  list(): Promise<BucketEntry[]>;
  read(key: string): Promise<Uint8Array>;
}
export const bucketName = (i: number) => `bucket-object-${i.toString().padStart(6, '0')}`;
export function inventory(entries: BucketEntry[]) {
  const parsed = entries
    .map((e) => bucketEntry.parse(e))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (new Set(parsed.map((e) => e.key)).size !== parsed.length)
    throw new RecoveryError('Duplicate bucket inventory.');
  return parsed;
}
export async function captureBucket(source: BucketSource, directory: string) {
  const before = inventory(await source.list());
  const captured = [];
  for (const [i, entry] of before.entries()) {
    const bytes = await source.read(entry.key);
    if (bytes.length !== entry.bytes) throw new RecoveryError('Bucket object size changed.');
    await writeFile(join(directory, bucketName(i)), bytes, { flag: 'wx', mode: 0o600 });
    captured.push({ ...entry, sha256: sha256(bytes) });
  }
  if (canonical(before) !== canonical(inventory(await source.list())))
    throw new RecoveryError('Bucket inventory changed during capture.');
  return captured;
}
export async function verifyBucket(directory: string, entries: z.infer<typeof bucketSchema>) {
  if (
    entries.length !== inventory(entries).length ||
    canonical(entries.map(({ sha256: _sha, ...e }) => e)) !== canonical(inventory(entries))
  )
    throw new RecoveryError('Invalid bucket inventory order.');
  const { lstat } = await import('node:fs/promises');
  for (const [i, entry] of entries.entries()) {
    const file = join(directory, bucketName(i));
    const stat = await lstat(file);
    if (
      !stat.isFile() ||
      stat.size !== entry.bytes ||
      stat.size > MAX_FILE_BYTES ||
      sha256(await readFile(file)) !== entry.sha256
    )
      throw new RecoveryError('Bucket object integrity check failed.');
  }
}
export function metadata(entry: BucketEntry) {
  return {
    ...entry.httpMetadata,
    ...(entry.httpMetadata.cacheExpiry
      ? { cacheExpiry: new Date(entry.httpMetadata.cacheExpiry) }
      : {}),
  } as R2HTTPMetadata;
}
