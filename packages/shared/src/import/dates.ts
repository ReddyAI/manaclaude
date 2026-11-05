import type { LocalDate } from '../model/common';
import type { DateFormat } from './types';

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/** Every format the detector tries, in order of preference when several fit. */
export const DATE_FORMATS: readonly DateFormat[] = [
  'YYYY-MM-DD',
  'YYYY/MM/DD',
  'YYYYMMDD',
  'MM/DD/YYYY',
  'DD/MM/YYYY',
  'MM-DD-YYYY',
  'DD-MM-YYYY',
  'DD.MM.YYYY',
  'MM/DD/YY',
  'DD/MM/YY',
  'DD-MMM-YYYY',
  'DD MMM YYYY',
  'MMM DD, YYYY',
  'DD-MMM-YY',
];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function build(y: number, m: number, d: number): LocalDate | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

function year2(y: number): number {
  // 00-69 -> 2000s, 70-99 -> 1900s (the usual pivot).
  return y < 70 ? 2000 + y : 1900 + y;
}

function num(s: string | undefined): number {
  return s !== undefined && /^\d+$/.test(s) ? Number(s) : NaN;
}

/** Parses one date string in the given format; null if it doesn't fit. */
export function parseDateWithFormat(raw: string, format: DateFormat): LocalDate | null {
  const value = raw.trim().replace(/\s+/g, ' ');
  if (!value) return null;
  let m: RegExpMatchArray | null;
  switch (format) {
    case 'YYYY-MM-DD':
      m = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/);
      return m ? build(num(m[1]), num(m[2]), num(m[3])) : null;
    case 'YYYY/MM/DD':
      m = value.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
      return m ? build(num(m[1]), num(m[2]), num(m[3])) : null;
    case 'YYYYMMDD':
      m = value.match(/^(\d{4})(\d{2})(\d{2})/);
      return m ? build(num(m[1]), num(m[2]), num(m[3])) : null;
    case 'MM/DD/YYYY':
      m = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      return m ? build(num(m[3]), num(m[1]), num(m[2])) : null;
    case 'DD/MM/YYYY':
      m = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      return m ? build(num(m[3]), num(m[2]), num(m[1])) : null;
    case 'MM-DD-YYYY':
      m = value.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
      return m ? build(num(m[3]), num(m[1]), num(m[2])) : null;
    case 'DD-MM-YYYY':
      m = value.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
      return m ? build(num(m[3]), num(m[2]), num(m[1])) : null;
    case 'DD.MM.YYYY':
      m = value.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
      return m ? build(num(m[3]), num(m[2]), num(m[1])) : null;
    case 'MM/DD/YY':
      m = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
      return m ? build(year2(num(m[3])), num(m[1]), num(m[2])) : null;
    case 'DD/MM/YY':
      m = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
      return m ? build(year2(num(m[3])), num(m[2]), num(m[1])) : null;
    case 'DD-MMM-YYYY':
      m = value.match(/^(\d{1,2})-([A-Za-z]{3,4})-(\d{4})$/);
      return m ? build(num(m[3]), MONTHS[m[2]!.toLowerCase()] ?? NaN, num(m[1])) : null;
    case 'DD MMM YYYY':
      m = value.match(/^(\d{1,2}) ([A-Za-z]{3,4}),? (\d{4})$/);
      return m ? build(num(m[3]), MONTHS[m[2]!.toLowerCase()] ?? NaN, num(m[1])) : null;
    case 'MMM DD, YYYY':
      m = value.match(/^([A-Za-z]{3,4})\.? (\d{1,2}),? (\d{4})$/);
      return m ? build(num(m[3]), MONTHS[m[1]!.toLowerCase()] ?? NaN, num(m[2])) : null;
    case 'DD-MMM-YY':
      m = value.match(/^(\d{1,2})-([A-Za-z]{3,4})-(\d{2})$/);
      return m ? build(year2(num(m[3])), MONTHS[m[2]!.toLowerCase()] ?? NaN, num(m[1])) : null;
  }
}

export interface DateFormatDetection {
  /** Best format, or null when none fits every value. */
  format: DateFormat | null;
  /** Every format that reads all the values. */
  candidates: DateFormat[];
  /** More than one candidate gives different dates (03/04/2026: March 4 or April 3?). */
  ambiguous: boolean;
}

export interface DetectOptions {
  /** Prefer day-first formats when ambiguous (Indian and most non-US statements). */
  preferDayFirst?: boolean;
}

/**
 * Finds the date format that reads every non-empty value. When several fit
 * (all days 12 or below) the result is marked ambiguous; US month-first wins
 * unless `preferDayFirst` is set, and the user can change it in the preview.
 */
export function detectDateFormat(
  values: readonly string[],
  options: DetectOptions = {},
): DateFormatDetection {
  const sample = values.map((v) => v.trim()).filter((v) => v.length > 0);
  if (sample.length === 0) return { format: null, candidates: [], ambiguous: false };
  const candidates = DATE_FORMATS.filter((f) =>
    sample.every((v) => parseDateWithFormat(v, f) !== null),
  );
  if (candidates.length === 0) return { format: null, candidates, ambiguous: false };
  // Ambiguous only if two candidates read some value differently.
  const ambiguous = candidates.some((f) =>
    sample.some((v) => parseDateWithFormat(v, f) !== parseDateWithFormat(v, candidates[0]!)),
  );
  let format = candidates[0]!;
  if (ambiguous && options.preferDayFirst) {
    format = candidates.find((f) => f.startsWith('DD')) ?? format;
  }
  return { format, candidates, ambiguous };
}
