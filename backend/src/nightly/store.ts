import type { Transaction } from '@manaclaude/shared';
import { fromRow, snake, toSqlValue, type TableSpec } from '../db/table';

import { transactionsTable } from '../db/tables';

export const PAGE = 8;
export const SCAN_PAGE = 16;
export const LEASE_MS = 120_000;

export async function page<T>(
  db: D1Database,
  table: TableSpec<T>,
  after: string,
  limit = PAGE,
  filter = '',
) {
  const rows = await db
    .prepare(
      `SELECT * FROM ${table.name} WHERE id > ? ${filter ? `AND (${filter})` : ''} ORDER BY id LIMIT ?`,
    )
    .bind(after, limit)
    .all<Record<string, unknown>>();
  return rows.results.map((r) => fromRow(table, r));
}

export async function byIds<T>(db: D1Database, table: TableSpec<T>, ids: (string | null)[]) {
  const unique = [...new Set(ids.filter((x): x is string => x !== null))];
  if (!unique.length) return [];
  const rows = await db
    .prepare(`SELECT * FROM ${table.name} WHERE id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(unique))
    .all<Record<string, unknown>>();
  return rows.results.map((r) => fromRow(table, r));
}

function comparison<T>(table: TableSpec<T>, objects: T[]) {
  const fields = Object.keys(table.columns) as (keyof T & string)[];
  const idIndex = fields.indexOf('id' as keyof T & string);
  const different = fields
    .map((field, i) => {
      const column = `t."${snake(field)}"`;
      const value = `json_extract(j.value, '$[${i}]')`;
      return table.columns[field] === 'json'
        ? `json(${column}) IS NOT json(${value})`
        : `${column} IS NOT ${value}`;
    })
    .join(' OR ');
  return {
    sql: `NOT EXISTS (SELECT 1 FROM json_each(?) j LEFT JOIN ${table.name} t
      ON t.id = json_extract(j.value, '$[${idIndex}]') WHERE t.id IS NULL OR ${different})`,
    data: JSON.stringify(
      objects.map((object) => fields.map((f) => toSqlValue(table.columns[f], object[f]))),
    ),
  };
}

/** Abort the batch rather than overwrite an edit made after reading an entity. */
export function unchanged<T>(db: D1Database, table: TableSpec<T>, objects: T[]) {
  const check = comparison(table, objects);
  return db
    .prepare(
      `INSERT OR REPLACE INTO nightly_guard (id, valid) SELECT 1, CASE WHEN ${check.sql} THEN 1 ELSE 0 END`,
    )
    .bind(check.data);
}

/** Batch guard aborts all effects when a lease was replaced or a source row changed. */
export function guard(db: D1Database, token: string, now: number, transactions: Transaction[]) {
  const check = comparison(transactionsTable, transactions);
  return db
    .prepare(
      `INSERT OR REPLACE INTO nightly_guard (id, valid)
    SELECT 1, CASE WHEN EXISTS (SELECT 1 FROM nightly_state
      WHERE id = 1 AND lease_token = ? AND lease_until > ?) AND ${check.sql}
    THEN 1 ELSE 0 END`,
    )
    .bind(token, now, check.data);
}

export function nameWrites(db: D1Database, kind: string, entries: { id: string; key: string }[]) {
  if (!entries.length) return [];
  return [
    db
      .prepare(
        `INSERT INTO nightly_names (kind, id, name_key)
    SELECT ?, json_extract(value, '$.id'), json_extract(value, '$.key') FROM json_each(?) WHERE true
    ON CONFLICT(kind, id) DO UPDATE SET name_key = excluded.name_key`,
      )
      .bind(kind, JSON.stringify(entries)),
  ];
}

export async function named<T>(db: D1Database, table: TableSpec<T>, kind: string, keys: string[]) {
  if (!keys.length) return [];
  // One existing record per key, even if old data contains duplicate names.
  const rows = await db
    .prepare(
      `SELECT t.* FROM json_each(?) j JOIN ${table.name} t ON t.id = (
    SELECT n.id FROM nightly_names n JOIN ${table.name} live ON live.id = n.id
    WHERE n.kind = ? AND n.name_key = j.value ORDER BY n.id LIMIT 1)`,
    )
    .bind(JSON.stringify([...new Set(keys)]), kind)
    .all<Record<string, unknown>>();
  return rows.results.map((r) => fromRow(table, r));
}
