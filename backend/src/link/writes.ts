import { newId } from '../util/ids';

export class LinkWriteChanged extends Error {}

/** Checks and effects share one transaction; a false check rolls back every effect. */
export async function writeLink(
  db: D1Database,
  checks: { sql: string; params: (string | number | null)[] }[],
  effects: D1PreparedStatement[],
): Promise<void> {
  const token = newId('guard');
  try {
    await db.batch([
      ...checks.map((check, i) =>
        db
          .prepare(
            `INSERT INTO link_write_guard (token, valid) SELECT ?, CASE WHEN (${check.sql}) THEN 1 ELSE 0 END`,
          )
          .bind(`${token}_${i}`, ...check.params),
      ),
      ...effects,
      ...checks.map((_, i) =>
        db.prepare('DELETE FROM link_write_guard WHERE token = ?').bind(`${token}_${i}`),
      ),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes('CHECK constraint failed: valid = 1')) {
      throw new LinkWriteChanged();
    }
    throw error;
  }
}

/** Compare encrypted bytes, without putting credentials in a guard or response. */
export const credentialStateSql = `SELECT json_array(iv, ciphertext) AS state FROM connection_credentials WHERE connection_id = ?`;
