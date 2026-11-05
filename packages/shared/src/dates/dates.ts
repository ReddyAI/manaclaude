import type { LocalDate, YearMonth } from '../model/common';

/**
 * Calendar helpers on "YYYY-MM-DD" strings. All math is done in UTC so a
 * date never shifts with the device's time zone.
 */

function parse(date: LocalDate): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`not a LocalDate: "${date}"`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function format(d: Date): LocalDate {
  return d.toISOString().slice(0, 10);
}

/** Today's calendar date on this device. */
export function todayLocal(now: Date = new Date()): LocalDate {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const d = parse(date);
  d.setUTCDate(d.getUTCDate() + days);
  return format(d);
}

/** Adds months, clamping the day (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(date: LocalDate, months: number): LocalDate {
  const d = parse(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return format(d);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: LocalDate, b: LocalDate): number {
  return Math.round((parse(b).getTime() - parse(a).getTime()) / 86_400_000);
}

export function monthOf(date: LocalDate): YearMonth {
  return date.slice(0, 7);
}

export function firstDayOfMonth(month: YearMonth): LocalDate {
  return `${month}-01`;
}

export function lastDayOfMonth(month: YearMonth): LocalDate {
  const d = parse(`${month}-01`);
  return format(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
}

export function daysInMonth(month: YearMonth): number {
  return Number(lastDayOfMonth(month).slice(8, 10));
}

export function addMonthsToMonth(month: YearMonth, months: number): YearMonth {
  return monthOf(addMonths(`${month}-01`, months));
}

/** 0 = Sunday ... 6 = Saturday */
export function dayOfWeek(date: LocalDate): number {
  return parse(date).getUTCDay();
}

export function isBetween(date: LocalDate, from: LocalDate, to: LocalDate): boolean {
  return date >= from && date <= to;
}

const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Nov 4" or "Nov 4, 2025" when the year differs from `relativeTo`. */
export function formatShortDate(date: LocalDate, relativeTo?: LocalDate): string {
  const d = parse(date);
  const base = `${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}`;
  if (relativeTo && relativeTo.slice(0, 4) !== date.slice(0, 4))
    return `${base}, ${d.getUTCFullYear()}`;
  return base;
}

/** "Tuesday, Nov 4" style header used in transaction lists, with Today and Yesterday. */
export function formatDayHeader(date: LocalDate, today: LocalDate): string {
  const diff = daysBetween(date, today);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  const d = parse(date);
  const year = date.slice(0, 4) !== today.slice(0, 4) ? `, ${d.getUTCFullYear()}` : '';
  return `${WEEKDAYS_SHORT[d.getUTCDay()]}, ${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}${year}`;
}

/** "November 2026" */
export function formatMonth(month: YearMonth): string {
  const d = parse(`${month}-01`);
  return `${MONTHS_LONG[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "Nov" */
export function formatMonthShort(month: YearMonth): string {
  return MONTHS_SHORT[Number(month.slice(5, 7)) - 1] ?? month;
}
