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
// Only identity and review-relevant state. Balance refreshes cannot invalidate a policy review.
// The same SQL runs INSIDE the write batch, closing the read/validate/write race without triggers.
export const historyStateSql = `SELECT json_array(
  coalesce((SELECT version FROM history_policy WHERE id = 1), 0),
  (SELECT json_group_array(json_array(id, type, currency, connection_id, external_id)) FROM (SELECT * FROM accounts ORDER BY id)),
  (SELECT json_group_array(json_array(id, account_id, date, amount, currency, source, external_id, import_id, import_fingerprint, split_parent_id, updated_at, user_edited_fields, name, raw_name, pending, pending_external_id, original_amount, original_currency)) FROM (SELECT * FROM transactions ORDER BY id)),
  (SELECT json_group_array(json_array(id, signature, status, updated_at, payload, previous, candidate_ids)) FROM (SELECT * FROM history_bank_reviews ORDER BY id))
) AS state`;
export async function historySnapshot(db: D1Database): Promise<string> {
  const row = await db
    .prepare(
      `WITH snapshot AS MATERIALIZED (${historyStateSql})
    SELECT CASE WHEN length(CAST(state AS BLOB)) <= 1000000 THEN state ELSE NULL END AS state FROM snapshot`,
    )
    .first<{ state: string | null }>();
  const state = row!.state;
  // Refuse before binding an oversized D1 value; never degrade to an unguarded write.
  if (state === null)
    throw conflict(
      'History review exceeds the synchronous safety limit. A bounded transition is required before changing or applying source policies.',
      'history_review_too_large',
    );
  return state;
}
export const tokenFor = (value: unknown) =>
  sha256Hex(new TextEncoder().encode(JSON.stringify(value)));
export function historyGuards(version: number, snapshot?: string): [StatementSpec, StatementSpec] {
  const token = newId('history');
  return [
    {
      sql: `INSERT INTO history_write_guard (token, valid) VALUES (?, CASE WHEN coalesce((SELECT version FROM history_policy WHERE id = 1), 0) = ?${snapshot === undefined ? '' : ` AND (${historyStateSql}) = ?`} THEN 1 ELSE 0 END)`,
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
