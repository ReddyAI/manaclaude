import { DEFAULT_FX_QUOTES, parseFrankfurter, parseOpenExchangeRates } from '@manaclaude/shared';
import type { Env } from '../env';
import { bulkInsertSpecs, runSpecs } from '../db/bulk';
import { fxRatesTable } from '../db/tables';
import { FRANKFURTER_URL, nextQuote } from './backfill';
import { OXR_LATEST_URL } from './service';

type Source = 'frankfurter_ecb' | 'openexchangerates';
const RESPONSE_BYTES = 32_768;

/** Defaults plus one cyclic discovered currency; no DISTINCT account inventory. */
export async function fetchScheduledLatest(
  env: Env,
  source: Source,
  doFetch: typeof fetch = fetch,
) {
  if (source === 'openexchangerates' && !env.OXR_APP_ID) return 0;
  const after =
    (await env.DB.prepare('SELECT last_quote FROM fx_latest_progress WHERE source = ?')
      .bind(source)
      .first<string>('last_quote')) ?? '';
  const quote = (await nextQuote(env.DB, after)) ?? (await nextQuote(env.DB, '')) ?? '';
  const quotes = [...new Set([...DEFAULT_FX_QUOTES, quote])].filter(
    (q) => q && q !== 'USD' && /^[A-Z]{3}$/.test(q),
  );
  const progress = {
    sql: `INSERT INTO fx_latest_progress (source, last_quote) VALUES (?, ?)
    ON CONFLICT(source) DO UPDATE SET last_quote = excluded.last_quote`,
    params: [source, quote],
    rows: 1,
  };
  try {
    const signal = AbortSignal.timeout(30_000);
    // Request the bounded latest table, then select our quotes. Filtering the
    // URL by a provider-unsupported symbol can reject every supported quote too.
    const url =
      source === 'openexchangerates'
        ? `${OXR_LATEST_URL}?app_id=${encodeURIComponent(env.OXR_APP_ID!)}`
        : `${FRANKFURTER_URL}/latest?base=USD`;
    const response = await doFetch(url, {
      signal,
      redirect: 'error',
      headers: { accept: 'application/json' },
    });
    if (!response.ok || !response.body)
      throw new Error(`Latest FX returned HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let body = '';
    try {
      while (true) {
        signal.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > RESPONSE_BYTES) throw new Error('Latest FX response too large');
        body += decoder.decode(part.value, { stream: true });
      }
    } finally {
      await reader.cancel();
    }
    const json: unknown = JSON.parse(body + decoder.decode());
    if (!json || typeof json !== 'object' || !('base' in json) || json.base !== 'USD')
      throw new Error('Invalid latest FX base');
    if (
      source === 'frankfurter_ecb' &&
      (!('date' in json) || typeof json.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(json.date))
    )
      throw new Error('Invalid latest FX date');
    const rates =
      source === 'openexchangerates'
        ? parseOpenExchangeRates(json, quotes)
        : parseFrankfurter(json, quotes);
    if (
      rates.some(
        (r) =>
          !Number.isFinite(r.rate) ||
          r.rate <= 0 ||
          !Number.isFinite(Date.parse(r.asOf)) ||
          new Date(r.asOf).toISOString().slice(0, 10) !== r.date,
      )
    )
      throw new Error('Invalid latest FX rate');
    // Reject a time-series-shaped reply: latest must have at most one row/quote.
    if (rates.length > quotes.length || new Set(rates.map((r) => r.quote)).size !== rates.length)
      throw new Error('Invalid latest FX response');
    const specs = bulkInsertSpecs(fxRatesTable, rates, 'upsert').map((s) => ({
      ...s,
      sql: `${s.sql} WHERE excluded.as_of >= fx_rates.as_of`,
    }));
    await runSpecs(env.DB, [...specs, progress]);
    return rates.length;
  } catch (error) {
    // A provider-unsupported currency must not starve later discovery.
    await runSpecs(env.DB, [progress]);
    throw error;
  }
}
