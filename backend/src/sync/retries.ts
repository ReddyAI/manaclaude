import type { StatementSpec } from '../db/bulk';

/** Consecutive failures back off from five minutes to at most one automatic attempt per day. */
const RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 3_600_000, 24 * 3_600_000];
export const FIRST_RETRY_DELAY_MS = RETRY_DELAYS_MS[0]!;

export function clearRetrySpec(connectionId: string): StatementSpec {
  return {
    sql: 'DELETE FROM sync_retries WHERE connection_id = ?',
    params: [connectionId],
    rows: 1,
  };
}

/** Increment and schedule in one statement so separate Worker invocations share the backoff. */
export function retryStatement(
  db: D1Database,
  connectionId: string,
  now: string,
  retryAfterSeconds: number | null = null,
): D1PreparedStatement {
  const time = Date.parse(now);
  const providerDelay = Math.max(0, retryAfterSeconds ?? 0) * 1000;
  return db
    .prepare(
      `
    INSERT INTO sync_retries (connection_id, attempts, next_retry_at) VALUES (?, 1, ?)
    ON CONFLICT (connection_id) DO UPDATE SET
      attempts = MIN(sync_retries.attempts + 1, 5),
      next_retry_at = MAX(?, ? + CAST(json_extract(?, '$[' || MIN(sync_retries.attempts, 4) || ']') AS INTEGER))
  `,
    )
    .bind(
      connectionId,
      time + Math.max(FIRST_RETRY_DELAY_MS, providerDelay),
      time + providerDelay,
      time,
      JSON.stringify(RETRY_DELAYS_MS),
    );
}

export async function retrySchedule(db: D1Database): Promise<Map<string, number>> {
  const rows = await db
    .prepare('SELECT connection_id, next_retry_at FROM sync_retries')
    .all<{ connection_id: string; next_retry_at: number }>();
  return new Map(rows.results.map((r) => [r.connection_id, r.next_retry_at]));
}
