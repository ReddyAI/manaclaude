import { snake, toSqlValue, type ColumnType, type TableSpec } from './table';

/**
 * Multi-row writes that cost one D1 query per chunk instead of one per row.
 *
 * Cloudflare's Workers Free plan allows about 50 D1 queries per invocation,
 * and every statement inside a db.batch() is assumed to count as one. A first
 * sync with two years of history (thousands of rows) would need thousands of
 * single-row INSERTs, so rows travel as one JSON array in a single bound
 * parameter and SQLite's json_each() expands them:
 *
 *   INSERT OR IGNORE INTO transactions (id, account_id, ...)
 *   SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), ... FROM json_each(?)
 *
 * Each row is an array of SQL values in column order (bools as 0/1, JSON
 * columns as their JSON text), so json_extract gives back exactly what a
 * single-row INSERT would have bound. Chunks stay well under D1's limits on
 * bound values (100 per query; here it is 1) and on string size (2 MB).
 */

export type SqlValue = string | number | null;

/** A statement before it is bound to a database, so plans can be counted and split. */
export interface StatementSpec {
  sql: string;
  params: SqlValue[];
  /** Rows this statement writes (for step sizes). */
  rows: number;
}

/** Most rows in one statement. */
export const BULK_MAX_ROWS = 400;
/** Most characters of JSON in one statement (far below the 2 MB string limit, even for non-Latin text). */
export const BULK_MAX_CHARS = 500_000;

function quote(column: string): string {
  return column === 'order' ? '"order"' : column;
}

function fieldsOf<T>(spec: TableSpec<T>): (keyof T & string)[] {
  return Object.keys(spec.columns) as (keyof T & string)[];
}

/** Rows of SQL values, cut into JSON array texts within the size limits. */
export function chunkRows(
  rows: readonly SqlValue[][],
  maxRows = BULK_MAX_ROWS,
  maxChars = BULK_MAX_CHARS,
): { json: string; rows: number }[] {
  const out: { json: string; rows: number }[] = [];
  let current: string[] = [];
  let chars = 2;
  const flush = () => {
    if (current.length === 0) return;
    out.push({ json: `[${current.join(',')}]`, rows: current.length });
    current = [];
    chars = 2;
  };
  for (const row of rows) {
    const text = JSON.stringify(row);
    if (current.length > 0 && (current.length >= maxRows || chars + text.length + 1 > maxChars)) {
      flush();
    }
    current.push(text);
    chars += text.length + 1;
  }
  flush();
  return out;
}

function extract(index: number, from = 'value'): string {
  return `json_extract(${from}, '$[${index}]')`;
}

/**
 * INSERT many rows of one table. `mode` matches insertStatement(): plain
 * insert, insert-or-ignore (the unique indexes skip rows already stored) or
 * upsert on the primary key.
 */
export function bulkInsertSpecs<T>(
  spec: TableSpec<T>,
  objects: readonly T[],
  mode: 'insert' | 'ignore' | 'upsert' = 'insert',
  limits: { maxRows?: number; maxChars?: number } = {},
): StatementSpec[] {
  if (objects.length === 0) return [];
  const fields = fieldsOf(spec);
  const cols = fields.map((f) => quote(snake(f)));
  const rows = objects.map((o) =>
    fields.map((f) => toSqlValue(spec.columns[f] as ColumnType, o[f])),
  );
  const verb = mode === 'ignore' ? 'INSERT OR IGNORE' : 'INSERT';
  let sql = `${verb} INTO ${spec.name} (${cols.join(', ')}) SELECT ${cols
    .map((_, i) => extract(i))
    .join(', ')} FROM json_each(?) WHERE true`;
  if (mode === 'upsert') {
    const keyCols = spec.key.map((k) => quote(snake(k)));
    const updates = cols.filter((c) => !keyCols.includes(c)).map((c) => `${c} = excluded.${c}`);
    sql += ` ON CONFLICT (${keyCols.join(', ')}) DO UPDATE SET ${updates.join(', ')}`;
  }
  return chunkRows(rows, limits.maxRows, limits.maxChars).map((c) => ({
    sql,
    params: [c.json],
    rows: c.rows,
  }));
}

export interface RowUpdate<T> {
  key: Partial<T>;
  changes: Partial<T>;
}

/**
 * UPDATE many rows. Rows that change the same set of columns share one
 * statement (UPDATE ... FROM json_each), so a sync that only moves amounts and
 * pending flags costs one or two queries however many rows it touches.
 */
export function bulkUpdateSpecs<T>(
  spec: TableSpec<T>,
  updates: readonly RowUpdate<T>[],
  limits: { maxRows?: number; maxChars?: number } = {},
): StatementSpec[] {
  const groups = new Map<string, { fields: (keyof T & string)[]; rows: SqlValue[][] }>();
  for (const u of updates) {
    const fields = (Object.keys(u.changes) as (keyof T & string)[])
      .filter((k) => k in spec.columns && !spec.key.includes(k))
      .sort();
    if (fields.length === 0) continue;
    const signature = fields.join(',');
    const group = groups.get(signature) ?? { fields, rows: [] };
    group.rows.push([
      ...spec.key.map((k) => toSqlValue(spec.columns[k] as ColumnType, u.key[k])),
      ...fields.map((f) => toSqlValue(spec.columns[f] as ColumnType, u.changes[f])),
    ]);
    groups.set(signature, group);
  }
  const out: StatementSpec[] = [];
  const keyCount = spec.key.length;
  for (const { fields, rows } of groups.values()) {
    const sets = fields.map((f, i) => `${quote(snake(f))} = ${extract(keyCount + i, 'j.value')}`);
    const where = spec.key.map(
      (k, i) => `${spec.name}.${quote(snake(k))} = ${extract(i, 'j.value')}`,
    );
    const sql = `UPDATE ${spec.name} SET ${sets.join(', ')} FROM json_each(?) AS j WHERE ${where.join(' AND ')}`;
    for (const c of chunkRows(rows, limits.maxRows, limits.maxChars)) {
      out.push({ sql, params: [c.json], rows: c.rows });
    }
  }
  return out;
}

/** `sql` with `IN (SELECT value FROM json_each(?))` filled from a list of ids, chunked. */
export function bulkByIdsSpecs(
  sqlWithIdList: string,
  ids: readonly string[],
  leadingParams: SqlValue[] = [],
): StatementSpec[] {
  if (ids.length === 0) return [];
  const out: StatementSpec[] = [];
  for (let i = 0; i < ids.length; i += 2000) {
    const chunk = ids.slice(i, i + 2000);
    out.push({
      sql: sqlWithIdList,
      params: [...leadingParams, JSON.stringify(chunk)],
      rows: chunk.length,
    });
  }
  return out;
}

export function toStatement(db: D1Database, s: StatementSpec): D1PreparedStatement {
  return db.prepare(s.sql).bind(...s.params);
}

/** Runs specs as one D1 batch (all or nothing). Returns the batch results. */
export async function runSpecs(
  db: D1Database,
  specs: readonly StatementSpec[],
): Promise<D1Result[]> {
  if (specs.length === 0) return [];
  return db.batch(specs.map((s) => toStatement(db, s)));
}

/** Rows written by a list of specs. */
export function rowsIn(specs: readonly StatementSpec[]): number {
  return specs.reduce((n, s) => n + s.rows, 0);
}
