import { addDays, DEFAULT_FX_QUOTES, parseFrankfurter, type FxRate } from '@manaclaude/shared';
import { bulkInsertSpecs, runSpecs, type StatementSpec } from '../db/bulk';
import { fxRatesTable } from '../db/tables';
import type { Env } from '../env';

export const FRANKFURTER_URL = 'https://api.frankfurter.dev/v1';
export const FX_BACKFILL_DAYS = 28;
export const FX_BACKFILL_LEASE_MS = 120_000;
export const FX_BACKFILL_RESPONSE_BYTES = 4096;
const REQUEST_DEADLINE_MS = 30_000;
type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
interface Progress {
  start_date: string;
  next_date: string;
}

function validDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

/** Limit decoded response bytes before parsing, including when Content-Length is absent. */
async function readDay(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`Frankfurter returned HTTP ${response.status}`);
  if (!response.body) throw new Error('Frankfurter response is empty');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > FX_BACKFILL_RESPONSE_BYTES) throw new Error('Frankfurter response is too large');
      text += decoder.decode(part.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally {
    await reader.cancel();
  }
}

/**
 * A dated endpoint resolves non-publication days to the preceding published date.
 * Validate each requested day: a sparse range response alone cannot prove that an
 * interior date/quote was not omitted. Keep the provider date, never invent rows.
 */
async function fetchDay(quote: string, date: string, fetcher: FetchFn, signal: AbortSignal) {
  const json = (await readDay(
    await fetcher(`${FRANKFURTER_URL}/${date}?base=USD&symbols=${quote}`, {
      signal,
      redirect: 'error',
    }),
  )) as { base?: unknown; amount?: unknown; date?: unknown; rates?: Record<string, unknown> };
  if (
    !json ||
    json.base !== 'USD' ||
    json.amount !== 1 ||
    !validDate(json.date) ||
    json.date > date ||
    json.date < addDays(date, -7) ||
    !json.rates ||
    typeof json.rates[quote] !== 'number' ||
    !Number.isFinite(json.rates[quote]) ||
    json.rates[quote] <= 0
  ) {
    throw new Error('Frankfurter historical response is incomplete or invalid');
  }
  return parseFrankfurter(json, [quote])[0]!;
}

/** One indexed minimum per source, one currency per invocation, cyclically. */
async function nextQuote(db: D1Database, after: string): Promise<string | null> {
  return db
    .prepare(
      `SELECT min(quote) FROM (
        SELECT min(currency) AS quote FROM accounts WHERE currency > ?
        UNION ALL SELECT min(currency) FROM transactions WHERE currency > ?
        UNION ALL SELECT min(value) FROM json_each(?) WHERE value > ?
      )`,
    )
    .bind(after, after, JSON.stringify(DEFAULT_FX_QUOTES), after)
    .first<string>('min(quote)');
}

/**
 * One bounded historical step, called by the existing hourly/daily FX crons. At most one
 * currency, 28 requested dates, 28 stored rows, 28 HTTP requests and 8 D1 queries
 * (9 if a committed batch's response is lost and cleanup is attempted).
 * Coverage comes only from this checkpoint, never min(fx_rates.date).
 */
export async function backfillMissingHistory(
  env: Env,
  doFetch: FetchFn = fetch,
  options: { now?: () => Date; through?: string } = {},
): Promise<number> {
  const now = options.now ?? (() => new Date());
  const through = options.through ?? addDays(now().toISOString().slice(0, 10), -1);
  if (!validDate(through)) throw new Error('Invalid FX backfill end date');
  const token = crypto.randomUUID();
  const time = now().getTime();
  const lease = await env.DB.prepare(
    `INSERT INTO fx_backfill_scheduler (id, lease_token, lease_until) VALUES (1, ?, ?)
     ON CONFLICT (id) DO UPDATE SET lease_token = excluded.lease_token,
       lease_until = excluded.lease_until WHERE fx_backfill_scheduler.lease_until <= ?
     RETURNING last_quote`,
  )
    .bind(token, time + FX_BACKFILL_LEASE_MS, time)
    .first<{ last_quote: string }>();
  if (!lease) return 0;
  let quote = lease.last_quote;
  const release = () =>
    env.DB.prepare(
      `UPDATE fx_backfill_scheduler SET last_quote = ?, lease_token = NULL, lease_until = 0
       WHERE id = 1 AND lease_token = ?`,
    ).bind(quote, token);
  try {
    const oldest = await env.DB.prepare('SELECT min(date) AS d FROM transactions').first<string>(
      'd',
    );
    if (!oldest || oldest > through) {
      await release().run();
      return 0;
    }
    if (!validDate(oldest)) throw new Error('Invalid oldest transaction date');
    quote = (await nextQuote(env.DB, quote)) ?? (await nextQuote(env.DB, '')) ?? '';
    // USD needs no cross rate. Unsupported provider currencies fail and rotate,
    // without a checkpoint, so they cannot starve the other currencies.
    if (!quote || quote === 'USD') {
      await release().run();
      return 0;
    }
    if (!/^[A-Z]{3}$/.test(quote)) throw new Error('Invalid historical currency');
    const progress = await env.DB.prepare(
      'SELECT start_date, next_date FROM fx_backfill_progress WHERE quote = ?',
    )
      .bind(quote)
      .first<Progress>();
    // An older import restarts verification. Previously stored rates are retained
    // and idempotently overwritten as we traverse them again.
    const restart = !progress || oldest < progress.start_date;
    const start = restart ? oldest : progress.start_date;
    const from = restart ? oldest : progress.next_date;
    if (from > through) {
      await release().run();
      return 0;
    }
    const to = [addDays(from, FX_BACKFILL_DAYS - 1), through].sort()[0]!;
    const signal = AbortSignal.timeout(REQUEST_DEADLINE_MS);
    const rates = new Map<string, FxRate>();
    for (let date = from; date <= to; date = addDays(date, 1)) {
      signal.throwIfAborted();
      const rate = await fetchDay(quote, date, doFetch, signal);
      rates.set(rate.date, rate);
    }
    signal.throwIfAborted();
    const commitTime = now().getTime();
    if (commitTime >= time + FX_BACKFILL_LEASE_MS) throw new Error('FX backfill lease expired');
    // Fence every write: a delayed worker cannot overwrite a replacement owner's
    // rates or checkpoint. D1 batch is atomic, including the release/cursor move.
    const guard =
      'EXISTS (SELECT 1 FROM fx_backfill_scheduler WHERE id = 1 AND lease_token = ? AND lease_until > ?)';
    const specs: StatementSpec[] = bulkInsertSpecs(fxRatesTable, [...rates.values()], 'upsert').map(
      (spec) => ({
        ...spec,
        sql: spec.sql.replace('WHERE true', `WHERE ${guard}`),
        params: [...spec.params, token, commitTime],
      }),
    );
    specs.push({
      sql: `INSERT INTO fx_backfill_progress (quote, start_date, next_date)
            SELECT ?, ?, ? WHERE ${guard}
            ON CONFLICT (quote) DO UPDATE SET start_date = excluded.start_date,
              next_date = excluded.next_date`,
      params: [quote, start, addDays(to, 1), token, commitTime],
      rows: 1,
    });
    specs.push({
      sql: `UPDATE fx_backfill_scheduler SET last_quote = ?, lease_token = NULL, lease_until = 0
            WHERE id = 1 AND lease_token = ?`,
      params: [quote, token],
      rows: 1,
    });
    const results = await runSpecs(env.DB, specs);
    return results[1]?.meta.changes ? rates.size : 0;
  } catch (error) {
    // Failure preserves coverage and rotates to the next currency. Abrupt death
    // instead leaves the cursor unchanged; the expired lease retries that work.
    await release().run();
    throw error;
  }
}
