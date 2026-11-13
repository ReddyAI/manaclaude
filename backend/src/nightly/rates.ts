import type { FxRate } from '@manaclaude/shared';
import { fromRow } from '../db/table';
import { fxRatesTable } from '../db/tables';

/** Six indexed pair seeks per requested conversion, including inverse/EUR fallback.
 * Also select the oldest row, matching shared findRate's pre-history fallback.
 * Returned rows are bounded by 12 * inputs, never the complete FX history.
 */
export async function ratesFor(
  db: D1Database,
  inputs: { from: string; to: string; date: string }[],
): Promise<FxRate[]> {
  const pairs = inputs.flatMap(({ from, to, date }) =>
    from === to
      ? []
      : [
          [from, to, date],
          [to, from, date],
          ['USD', from, date],
          ['USD', to, date],
          ['EUR', from, date],
          ['EUR', to, date],
        ],
  );
  if (!pairs.length) return [];
  const rows = await db
    .prepare(
      `SELECT DISTINCT r.* FROM json_each(?) j JOIN fx_rates r ON r.rowid IN (
    COALESCE((SELECT rowid FROM fx_rates WHERE base = json_extract(j.value, '$[0]')
      AND quote = json_extract(j.value, '$[1]') AND date <= json_extract(j.value, '$[2]')
      ORDER BY date DESC, as_of DESC LIMIT 1),
    (SELECT rowid FROM fx_rates WHERE base = json_extract(j.value, '$[0]')
      AND quote = json_extract(j.value, '$[1]') ORDER BY date, as_of LIMIT 1)))`,
    )
    .bind(JSON.stringify(pairs))
    .all<Record<string, unknown>>();
  return rows.results.map((r) => fromRow(fxRatesTable, r));
}
