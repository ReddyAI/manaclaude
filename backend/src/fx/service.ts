import {
  DEFAULT_FX_QUOTES,
  findRate,
  parseFrankfurter,
  parseOpenExchangeRates,
  type CurrencyCode,
  type FxRate,
  type LocalDate,
} from '@manaclaude/shared';
import type { Env } from '../env';
import { bulkInsertSpecs, runSpecs } from '../db/bulk';
import { selectAll } from '../db/table';
import { fxRatesTable } from '../db/tables';

import { FRANKFURTER_URL } from './backfill';

export const OXR_LATEST_URL = 'https://openexchangerates.org/api/latest.json';
export { backfillMissingHistory, FRANKFURTER_URL } from './backfill';

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Currencies to store: the defaults plus every account currency. */
export async function quoteCurrencies(db: D1Database): Promise<CurrencyCode[]> {
  const res = await db
    .prepare('SELECT DISTINCT currency FROM accounts')
    .all<{ currency: string }>();
  return [...new Set([...DEFAULT_FX_QUOTES, ...res.results.map((r) => r.currency)])].filter(
    (c) => c !== 'USD',
  );
}

/** Upserts rates with multi-row statements: two years of daily rates is a handful of D1 queries. */
export async function storeRates(db: D1Database, rates: readonly FxRate[]): Promise<number> {
  await runSpecs(db, bulkInsertSpecs(fxRatesTable, rates, 'upsert'));
  return rates.length;
}

/** Hourly cron: Open Exchange Rates latest.json (USD base). Needs the OXR_APP_ID secret. */
export async function fetchOpenExchangeRates(env: Env, doFetch: FetchFn = fetch): Promise<number> {
  if (!env.OXR_APP_ID) return 0;
  const res = await doFetch(`${OXR_LATEST_URL}?app_id=${encodeURIComponent(env.OXR_APP_ID)}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Open Exchange Rates returned HTTP ${res.status}`);
  const rates = parseOpenExchangeRates(await res.json(), await quoteCurrencies(env.DB));
  return storeRates(env.DB, rates);
}

/** Daily cron: ECB rates through Frankfurter (no key). Fallback and history. */
export async function fetchFrankfurterLatest(env: Env, doFetch: FetchFn = fetch): Promise<number> {
  const quotes = await quoteCurrencies(env.DB);
  const res = await doFetch(`${FRANKFURTER_URL}/latest?base=USD&symbols=${quotes.join(',')}`);
  if (!res.ok) throw new Error(`Frankfurter returned HTTP ${res.status}`);
  return storeRates(env.DB, parseFrankfurter(await res.json(), quotes));
}

/** Backfills daily ECB history for a range (used for old imports and reports). */
export async function backfillFrankfurter(
  env: Env,
  from: LocalDate,
  to: LocalDate,
  doFetch: FetchFn = fetch,
): Promise<number> {
  const quotes = await quoteCurrencies(env.DB);
  const res = await doFetch(
    `${FRANKFURTER_URL}/${from}..${to}?base=USD&symbols=${quotes.join(',')}`,
  );
  if (!res.ok) throw new Error(`Frankfurter returned HTTP ${res.status}`);
  return storeRates(env.DB, parseFrankfurter(await res.json(), quotes));
}

export function loadRates(db: D1Database): Promise<FxRate[]> {
  return selectAll(db, fxRatesTable, '', [], 'date');
}

/**
 * Latest rate for a pair. Prefers the hourly OXR rate; falls back to ECB.
 * findRate already crosses through USD.
 */
export async function latestRate(db: D1Database, base: CurrencyCode, quote: CurrencyCode) {
  const rates = await loadRates(db);
  const oxr = rates.filter((r) => r.source === 'openexchangerates');
  return (
    findRate(oxr.length > 0 ? oxr : rates, base, quote, { mode: 'latest' }) ??
    findRate(rates, base, quote, { mode: 'latest' })
  );
}
