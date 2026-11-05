/**
 * A tiny typed layer over D1: each table is described once (field -> column
 * type), and rows are converted to and from the shared model objects.
 * Column names are the snake_case of the field names.
 */

export type ColumnType = 'text' | 'int' | 'real' | 'bool' | 'json';

export interface TableSpec<T> {
  name: string;
  /** Primary key fields, used for upserts. */
  key: (keyof T & string)[];
  columns: { [K in keyof T & string]: ColumnType };
}

export function snake(field: string): string {
  return field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function quote(column: string): string {
  return column === 'order' ? '"order"' : column;
}

export function defineTable<T>(spec: TableSpec<T>): TableSpec<T> {
  return spec;
}

type SqlValue = string | number | null;

export function toSqlValue(type: ColumnType, value: unknown): SqlValue {
  if (value === undefined || value === null) return type === 'json' ? '[]' : null;
  switch (type) {
    case 'bool':
      return value ? 1 : 0;
    case 'json':
      return JSON.stringify(value);
    case 'int':
    case 'real':
      return Number(value);
    case 'text':
      return String(value);
  }
}

export function fromRow<T>(spec: TableSpec<T>, row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [field, type] of Object.entries(spec.columns) as [string, ColumnType][]) {
    const v = row[snake(field)];
    if (v === null || v === undefined) {
      out[field] = type === 'json' ? [] : type === 'bool' ? false : null;
      continue;
    }
    switch (type) {
      case 'bool':
        out[field] = v === 1 || v === true || v === '1';
        break;
      case 'json':
        out[field] = typeof v === 'string' ? JSON.parse(v) : v;
        break;
      case 'int':
      case 'real':
        out[field] = Number(v);
        break;
      case 'text':
        out[field] = String(v);
        break;
    }
  }
  return out as T;
}

function fields<T>(spec: TableSpec<T>): (keyof T & string)[] {
  return Object.keys(spec.columns) as (keyof T & string)[];
}

export function insertStatement<T>(
  db: D1Database,
  spec: TableSpec<T>,
  obj: T,
  mode: 'insert' | 'ignore' | 'upsert' = 'insert',
): D1PreparedStatement {
  const f = fields(spec);
  const cols = f.map((x) => quote(snake(x)));
  const values = f.map((x) => toSqlValue(spec.columns[x], obj[x]));
  const verb = mode === 'ignore' ? 'INSERT OR IGNORE' : 'INSERT';
  let sql = `${verb} INTO ${spec.name} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  if (mode === 'upsert') {
    const keyCols = spec.key.map((k) => quote(snake(k)));
    const updates = cols.filter((c) => !keyCols.includes(c)).map((c) => `${c} = excluded.${c}`);
    sql += ` ON CONFLICT (${keyCols.join(', ')}) DO UPDATE SET ${updates.join(', ')}`;
  }
  return db.prepare(sql).bind(...values);
}

/** UPDATE the given fields of one row, located by primary key. */
export function updateStatement<T>(
  db: D1Database,
  spec: TableSpec<T>,
  key: Partial<T>,
  changes: Partial<T>,
): D1PreparedStatement {
  const changed = (Object.keys(changes) as (keyof T & string)[]).filter((k) => k in spec.columns);
  if (changed.length === 0) throw new Error(`No columns to update in ${spec.name}`);
  const sets = changed.map((k) => `${quote(snake(k))} = ?`);
  const where = spec.key.map((k) => `${quote(snake(k))} = ?`);
  const values = [
    ...changed.map((k) => toSqlValue(spec.columns[k], changes[k])),
    ...spec.key.map((k) => toSqlValue(spec.columns[k], key[k])),
  ];
  return db
    .prepare(`UPDATE ${spec.name} SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`)
    .bind(...values);
}

export async function selectAll<T>(
  db: D1Database,
  spec: TableSpec<T>,
  where = '',
  params: SqlValue[] = [],
  orderBy = '',
): Promise<T[]> {
  const sql = `SELECT * FROM ${spec.name}${where ? ` WHERE ${where}` : ''}${orderBy ? ` ORDER BY ${orderBy}` : ''}`;
  const res = await db
    .prepare(sql)
    .bind(...params)
    .all<Record<string, unknown>>();
  return res.results.map((r) => fromRow(spec, r));
}

export async function selectOne<T>(
  db: D1Database,
  spec: TableSpec<T>,
  where: string,
  params: SqlValue[],
): Promise<T | null> {
  const row = await db
    .prepare(`SELECT * FROM ${spec.name} WHERE ${where} LIMIT 1`)
    .bind(...params)
    .first<Record<string, unknown>>();
  return row ? fromRow(spec, row) : null;
}

/** D1 limits a batch; split long statement lists into chunks. Each chunk is atomic. */
export async function batchInChunks(
  db: D1Database,
  statements: D1PreparedStatement[],
  size = 50,
): Promise<void> {
  for (let i = 0; i < statements.length; i += size) {
    await db.batch(statements.slice(i, i + size));
  }
}
