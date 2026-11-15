import { type StatementSpec, runSpecs } from '../db/bulk';
import { conflict } from '../util/errors';
import { newId, sha256Hex } from '../util/ids';
import { EMPTY_POLICY, type HistoryPolicy, type PolicyState } from './model';

export async function readPolicy(db: D1Database): Promise<PolicyState> {
  const row = await db
    .prepare('SELECT version, config, review_token FROM history_policy WHERE id = 1')
    .first<{ version: number; config: string; review_token: string }>();
  return row
    ? {
        version: row.version,
        policy: JSON.parse(row.config) as HistoryPolicy,
        reviewToken: row.review_token,
      }
    : { version: 0, policy: EMPTY_POLICY, reviewToken: null };
}
// A single indexed row replaces the old database-wide serialized snapshot. The
// migration's triggers change it in the SAME transaction as every relevant write.
// Read before the data used for a decision; compare inside the atomic effect batch.
export const historyRevisionSql = 'SELECT revision FROM history_revision WHERE id = 1';
export async function historySnapshot(db: D1Database): Promise<string> {
  const revision = await db.prepare(historyRevisionSql).first<string>('revision');
  if (!revision || !/^[a-f0-9]{64}$/.test(revision))
    throw conflict(
      'History concurrency state is unavailable. Restore the complete database with its matching migrations before retrying.',
      'history_policy_changed',
    );
  return revision;
}
export const tokenFor = (value: unknown) =>
  sha256Hex(new TextEncoder().encode(JSON.stringify(value)));
export function historyGuards(version: number, snapshot?: string): [StatementSpec, StatementSpec] {
  const token = newId('history');
  return [
    {
      sql: `INSERT INTO history_write_guard (token, valid) VALUES (?, CASE WHEN coalesce((SELECT version FROM history_policy WHERE id = 1), 0) = ?${snapshot === undefined ? '' : ` AND (${historyRevisionSql}) = ?`} THEN 1 ELSE 0 END)`,
      params: [token, version, ...(snapshot === undefined ? [] : [snapshot])],
      rows: 1,
    },
    { sql: 'DELETE FROM history_write_guard WHERE token = ?', params: [token], rows: 1 },
  ];
}
export async function writeHistory(db: D1Database, specs: StatementSpec[]): Promise<void> {
  try {
    await runSpecs(db, specs);
  } catch (error) {
    if (error instanceof Error && error.message.includes('CHECK constraint failed: valid = 1'))
      throw conflict(
        'History or its source policy changed. Reload and review before retrying.',
        'history_policy_changed',
      );
    throw error;
  }
}
