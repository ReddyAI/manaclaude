import { DatabaseSync, constants } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

export const MAX_SQL_BYTES = 64 * 1024 * 1024;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Only these controlled messages may be printed; storage/SQL errors may contain private data. */
export class RecoveryError extends Error {}
export const sha256 = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
export const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => compare(a, b)))
      : item,
  );
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

type Row = Record<string, string | number | null>;
export interface RecoveryTable {
  name: string;
  sql: string;
  columns: string[];
  rows: Row[];
}
export interface FileReference {
  kind: 'statement' | 'receipt';
  id: string;
  key: string;
  contentType: string | null;
  size: number | null;
  sha256: string | null;
  customMetadata: Record<string, string>;
}
export interface DatabaseImage {
  tables: RecoveryTable[];
  indexes: string[];
  files: FileReference[];
}

function rows(db: DatabaseSync, sql: string): Row[] {
  const stmt = db.prepare(sql);
  stmt.setReadBigInts(true);
  return stmt.all().map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => {
        if (typeof value === 'bigint') {
          if (!Number.isSafeInteger(Number(value)))
            throw new RecoveryError('Unsafe integer in export.');
          return [key, Number(value)];
        }
        if (value instanceof Uint8Array) throw new RecoveryError('BLOB columns are not supported.');
        return [key, value];
      }),
    ),
  );
}

/** Decode a native D1 SQL export; never open/attach a filesystem database. */
export function inspectDatabase(sql: string): DatabaseImage {
  if (Buffer.byteLength(sql) > MAX_SQL_BYTES) throw new RecoveryError('SQL export exceeds 64 MiB.');
  const db = new DatabaseSync(':memory:');
  try {
    if (typeof db.setAuthorizer !== 'function')
      throw new RecoveryError('Recovery requires Node 24.10 or newer.');
    db.setAuthorizer((action, arg1) => {
      if (
        [
          constants.SQLITE_ATTACH,
          constants.SQLITE_DETACH,
          constants.SQLITE_CREATE_VTABLE,
          constants.SQLITE_CREATE_TRIGGER,
          constants.SQLITE_CREATE_VIEW,
        ].includes(action) ||
        (action === constants.SQLITE_PRAGMA &&
          !['defer_foreign_keys', 'foreign_keys'].includes(arg1?.toLowerCase() ?? ''))
      )
        return constants.SQLITE_DENY;
      return constants.SQLITE_OK;
    });
    db.exec(sql);
    db.setAuthorizer(null);
    if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok')
      throw new RecoveryError('Database integrity check failed.');
    if (db.prepare('PRAGMA foreign_key_check').all().length)
      throw new RecoveryError('Database foreign-key check failed.');

    const schema = rows(
      db,
      "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    );
    const tables = schema
      .filter((s) => s.type === 'table')
      .map((s) => {
        const name = String(s.name);
        return {
          name,
          sql: String(s.sql),
          columns: rows(db, `PRAGMA table_info(${quote(name)})`).map((c) => String(c.name)),
          rows: rows(db, `SELECT * FROM ${quote(name)}`).sort((a, b) =>
            compare(canonical(a), canonical(b)),
          ),
        };
      });
    // A partial --table/--no-schema export is not a recovery backup. Compare all
    // application table columns with the checked-out migrations, including empty tables.
    const expected = new DatabaseSync(':memory:');
    try {
      const migrations = new URL('../migrations/', import.meta.url);
      for (const name of readdirSync(migrations)
        .filter((n) => n.endsWith('.sql'))
        .sort())
        expected.exec(readFileSync(new URL(name, migrations), 'utf8'));
      const names = rows(expected, "SELECT name FROM sqlite_schema WHERE type = 'table'");
      if (tables.some((t) => t.name !== 'd1_migrations' && !names.some((n) => n.name === t.name)))
        throw new RecoveryError(
          'Unsupported database schema; use the matching recovery code revision.',
        );
      for (const { name } of names) {
        const actual = tables.find((t) => t.name === name);
        const columns = rows(expected, `PRAGMA table_info(${quote(String(name))})`).map((c) =>
          String(c.name),
        );
        if (!actual || canonical(columns) !== canonical(actual.columns))
          throw new RecoveryError('Incomplete or incompatible D1 export.');
      }
    } finally {
      expected.close();
    }
    // Most model relationships predate foreign keys in this schema.
    for (const [table, column, target] of [
      ['transactions', 'account_id', 'accounts'],
      ['transactions', 'category_id', 'categories'],
      ['transactions', 'receipt_id', 'receipts'],
      ['transactions', 'import_id', 'imports'],
      ['transactions', 'split_parent_id', 'transactions'],
      ['transactions', 'transfer_link_id', 'transfer_links'],
      ['receipts', 'matched_transaction_id', 'transactions'],
      ['transfer_links', 'out_transaction_id', 'transactions'],
      ['transfer_links', 'in_transaction_id', 'transactions'],
      ['balance_snapshots', 'account_id', 'accounts'],
    ] as const) {
      const orphan = db
        .prepare(
          `SELECT 1 FROM ${quote(table)} a LEFT JOIN ${quote(target)} b ON a.${quote(column)} = b.id WHERE a.${quote(column)} IS NOT NULL AND b.id IS NULL ${table === 'transfer_links' ? "AND a.status != 'rejected'" : ''} LIMIT 1`,
        )
        .get();
      if (orphan) throw new RecoveryError(`Broken relationship: ${table}.${column}.`);
    }
    if (db.prepare("SELECT 1 FROM imports WHERE status = 'committing' LIMIT 1").get())
      throw new RecoveryError(
        'An import is committing; recover it and stop writers before exporting.',
      );
    const files: FileReference[] = [
      ...rows(db, 'SELECT * FROM imports').map((r) => ({
        kind: 'statement' as const,
        id: String(r.id),
        key: String(r.r2_key),
        contentType: String(r.content_type),
        size: Number(r.size),
        sha256: String(r.sha256),
        customMetadata: {
          importId: String(r.id),
          sha256: String(r.sha256),
          fileName: String(r.file_name).slice(0, 200),
        },
      })),
      ...rows(db, 'SELECT * FROM receipts').map((r) => ({
        kind: 'receipt' as const,
        id: String(r.id),
        key: String(r.r2_key),
        contentType: null,
        size: null,
        sha256: null,
        customMetadata: {},
      })),
    ].sort((a, b) => compare(a.key, b.key));
    if (new Set(files.map((f) => f.key)).size !== files.length)
      throw new RecoveryError('Multiple records reference the same object key.');
    for (const f of files) {
      if (!f.key.startsWith(f.kind === 'statement' ? 'vault/' : 'receipts/'))
        throw new RecoveryError('Unexpected original-file key.');
    }
    return {
      tables,
      indexes: schema.filter((s) => s.type === 'index' && s.sql).map((s) => String(s.sql)),
      files,
    };
  } finally {
    db.close();
  }
}

export function tableInventory(image: DatabaseImage) {
  return image.tables.map((t) => ({
    name: t.name,
    rows: t.rows.length,
    sha256: sha256(canonical(t)),
  }));
}

export function validateFile(ref: FileReference, bytes: Uint8Array, contentType: string) {
  if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES)
    throw new RecoveryError('Original file is empty or exceeds 20 MiB.');
  if (ref.kind === 'statement') {
    if (
      bytes.length !== ref.size ||
      sha256(bytes) !== ref.sha256 ||
      contentType !== ref.contentType
    )
      throw new RecoveryError('Statement differs from its stored size, SHA-256 or content type.');
  } else {
    const b = Buffer.from(bytes);
    const valid =
      (contentType === 'image/png' &&
        b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) ||
      (contentType === 'image/jpeg' && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) ||
      (contentType === 'image/gif' && /^GIF8[79]a/.test(b.subarray(0, 6).toString())) ||
      (contentType === 'image/webp' &&
        b.toString('ascii', 0, 4) === 'RIFF' &&
        b.toString('ascii', 8, 12) === 'WEBP');
    if (!valid)
      throw new RecoveryError('Receipt signature does not match its supported image type.');
  }
}
