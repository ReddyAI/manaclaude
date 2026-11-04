import type { LocalDate } from '../model/common';
import type { FxRate } from '../model/fx';
import { addDays } from '../dates/dates';
import { createRandom } from './random';

/**
 * Sample rates with base USD: 150 days of daily ECB-style rates plus one
 * "latest" hourly rate. Values are made up near late-2026 levels.
 */
export function sampleFxRates(today: LocalDate, now: Date): FxRate[] {
  const rnd = createRandom(99);
  const out: FxRate[] = [];
  let inr = 87.4;
  let eur = 0.915;
  for (let i = 150; i >= 1; i -= 1) {
    const date = addDays(today, -i);
    inr = Math.max(85, Math.min(91, inr + (rnd.next() - 0.47) * 0.18));
    eur = Math.max(0.86, Math.min(0.96, eur + (rnd.next() - 0.5) * 0.004));
    const asOf = `${date}T14:00:00.000Z`;
    out.push({ base: 'USD', quote: 'INR', rate: Math.round(inr * 10_000) / 10_000, asOf, date, source: 'frankfurter_ecb' });
    out.push({ base: 'USD', quote: 'EUR', rate: Math.round(eur * 100_000) / 100_000, asOf, date, source: 'frankfurter_ecb' });
  }
  const asOf = new Date(now.getTime() - 23 * 60_000).toISOString();
  out.push({ base: 'USD', quote: 'INR', rate: Math.round((inr + 0.06) * 10_000) / 10_000, asOf, date: today, source: 'openexchangerates' });
  out.push({ base: 'USD', quote: 'EUR', rate: Math.round(eur * 100_000) / 100_000, asOf, date: today, source: 'openexchangerates' });
  return out;
}
