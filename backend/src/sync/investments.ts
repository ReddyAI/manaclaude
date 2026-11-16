import type { StatementSpec } from '../db/bulk';
import { conflict } from '../util/errors';
import { newId } from '../util/ids';

// Capture before provider I/O, not after the response arrives. Any intervening
// investment write (including another empty sync) makes that response obsolete.
export async function investmentRevision(db: D1Database): Promise<string> {
  const revision = await db
    .prepare('SELECT revision FROM investment_revision WHERE id = 1')
    .first<string>('revision');
  if (!revision || !/^[a-f0-9]{64}$/.test(revision))
    throw conflict(
      'Investment concurrency state is unavailable. Restore the complete matching schema.',
      'investment_snapshot_changed',
    );
  return revision;
}

export function investmentGuards(revision: string): [StatementSpec, StatementSpec] {
  const token = newId('investment');
  return [
    {
      sql: `INSERT INTO investment_write_guard VALUES (?, CASE WHEN
      (SELECT revision FROM investment_revision WHERE id = 1) = ? THEN 1 ELSE 0 END)`,
      params: [token, revision],
      rows: 1,
    },
    { sql: 'DELETE FROM investment_write_guard WHERE token = ?', params: [token], rows: 1 },
  ];
}
export const advanceInvestmentRevision: StatementSpec = {
  sql: 'UPDATE investment_revision SET revision = lower(hex(randomblob(32))) WHERE id = 1',
  params: [],
  rows: 1,
};
