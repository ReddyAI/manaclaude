import type { IsoDateTime, LocalDate } from '@manaclaude/shared';
import { addDays } from '@manaclaude/shared';

/**
 * Provider date or timestamp to a LocalDate.
 * - "2026-10-30" stays as is
 * - "2026-10-30T23:30:00-07:00" keeps the provider's own calendar date (2026-10-30)
 * - "2026-10-30T23:30:00Z" uses the UTC date
 * - numbers are epoch seconds (or milliseconds when above 1e11) in UTC
 */
export function toLocalDate(input: string | number | Date | null | undefined): LocalDate | null {
  if (input === null || input === undefined || input === '') return null;
  if (input instanceof Date)
    return Number.isNaN(input.getTime()) ? null : input.toISOString().slice(0, 10);
  if (typeof input === 'number') {
    const ms = input > 1e11 ? input : input * 1000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  const text = input.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const compact = /^(\d{4})(\d{2})(\d{2})/.exec(text);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const dmy = /^(\d{2})[./](\d{2})[./](\d{4})$/.exec(text);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  if (/^\d{9,13}$/.test(text)) return toLocalDate(Number(text));
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

export function requireLocalDate(
  input: string | number | Date | null | undefined,
  what: string,
): LocalDate {
  const date = toLocalDate(input);
  if (!date) throw new Error(`${what}: unreadable date ${JSON.stringify(input)}`);
  return date;
}

export function todayUtc(now: Date): LocalDate {
  return now.toISOString().slice(0, 10);
}

export function isoNow(now: Date): IsoDateTime {
  return now.toISOString();
}

/** Start date for a sync window: the cursor date minus an overlap, or `backfillDays` back on the first sync. */
export function windowStart(
  today: LocalDate,
  sinceCursor: LocalDate | null,
  opts: { backfillDays: number; overlapDays: number },
): LocalDate {
  return sinceCursor ? addDays(sinceCursor, -opts.overlapDays) : addDays(today, -opts.backfillDays);
}
